/**
 * Training/batch/accelerator workload domain (sandbox module; WORK-030,
 * ACC-001/ACC-002/ACC-003).
 *
 * A training, fine-tuning, large-batch-inference or evaluation workload
 * is a governed EXECUTION PARTICIPANT on the sandbox axis — the
 * long-running twin of `SandboxExecution`: it consumes an ACCELERATOR
 * substrate fleet, runs for a long time, emits CHECKPOINTS, and is
 * resumable with a STABLE execution identity. It is NOT a second
 * execution system:
 *
 *   - the execution lifecycle authority stays in `/executions` (this
 *     row never writes execution status; provenance rides the
 *     executions EventEnvelope ledger as step events through the
 *     REQUIRED ledger seam, using the EXISTING step-event vocabulary —
 *     sandbox-admitted / sandbox-denied / sandbox-completed for the
 *     admission/outcome axis, checkpoint-recorded / interruption-
 *     requested / resume-recorded / resume-denied for the long-running
 *     axis);
 *   - policy, capability and budget decisions belong to THEIR
 *     authorities and are consulted through REQUIRED seams — never
 *     reimplemented here;
 *   - accelerator/substrate selection is PROVIDER-NEUTRAL: the request
 *     is a capability/resource contract (class + device count +
 *     per-device memory + interconnect), the substrate is a claim in
 *     the capabilities module's registry, and the concrete fleet lives
 *     behind the replaceable accelerator-substrate seam (an adapter,
 *     never a platform authority). Vendor vocabularies (GPU/accelerator
 *     vendor names, training-framework names) are structurally absent
 *     from every contract in this file — the provider-substitution
 *     discrimination proves the abstraction is unchanged when the
 *     substrate adapter is swapped.
 *
 * Security/resource model at this layer (the Work Order's binding
 * implementation requirements):
 *   - RESOURCE ESTIMATES ARE EXPLICIT AND AUDITABLE: every executing
 *     workload declares a bounded, fully-numeric resource estimate
 *     (accelerator request, replicas, cpu, memory, duration, cost) — a
 *     missing or non-numeric estimate is a validation failure, never a
 *     silent default (budget admission reads THIS estimate);
 *   - CHECKPOINT IDENTITIES ARE IMMUTABLE AND CONTENT/LINEAGE
 *     ADDRESSABLE: a checkpoint row is write-once, its identity is the
 *     sha256 content digest over the canonical serialization of its
 *     contents (bound to the workload/execution identity, the lineage
 *     refs and the step position), and it is findable by digest
 *     (content-addressable) and by lineage (lineage-addressable);
 *   - FAILED RUNS ARE NEVER VERIFIED RELEASES: the domain vocabulary
 *     has NO state that presents a failed or unverified run as a
 *     released model — the release dimension is a separate, initially
 *     null field that only the verification-gate operation (which
 *     consults the verification authority) can ever set.
 */

import { PlatformError } from "../../../shared/errors";
import { REF_PATTERN, refLooksLikeHostPath } from "./environment";
import type { SandboxTask } from "./sandbox";

// ---------------------------------------------------------------------------
// Workload kinds (ACC-001) and the provider-neutral accelerator vocabulary
// ---------------------------------------------------------------------------

/**
 * The governed long-running workload classes. Provider-neutral and
 * workload-shape based: what the workload DOES, never which vendor's
 * stack it runs on.
 */
export const TRAINING_WORKLOAD_KINDS = [
  "training",
  "fine-tuning",
  "batch-inference",
  "evaluation",
] as const;

export type TrainingWorkloadKind = (typeof TRAINING_WORKLOAD_KINDS)[number];

export function isTrainingWorkloadKind(value: string): value is TrainingWorkloadKind {
  return (TRAINING_WORKLOAD_KINDS as readonly string[]).includes(value);
}

/**
 * The neutral accelerator device classes. These are DEVICE FUNCTION
 * classes (the generic hardware taxonomy), deliberately not vendor or
 * product names: vendor specifics live behind the replaceable
 * accelerator-substrate adapter, never in this contract.
 */
export const ACCELERATOR_CLASSES = [
  "gpu",
  "tensor-accelerator",
  "inference-accelerator",
  "vector-signal-processor",
] as const;

export type AcceleratorClass = (typeof ACCELERATOR_CLASSES)[number];

export function isAcceleratorClass(value: string): value is AcceleratorClass {
  return (ACCELERATOR_CLASSES as readonly string[]).includes(value);
}

/** Neutral interconnect classes (device-to-device topology). */
export const INTERCONNECT_CLASSES = ["none", "interconnect-fabric"] as const;

export type InterconnectClass = (typeof INTERCONNECT_CLASSES)[number];

export function isInterconnectClass(value: string): value is InterconnectClass {
  return (INTERCONNECT_CLASSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The accelerator resource request (ACC-002 — the provider-neutral
// capability/resource contract)
// ---------------------------------------------------------------------------

/**
 * The accelerator request: WHAT the workload needs, expressed as a
 * neutral capability/resource contract — never WHERE it comes from.
 * Selection matches this request against substrate CLAIMS in the
 * capabilities registry (the one claim authority); the concrete fleet
 * allocation happens behind the accelerator-substrate seam after
 * budget admission.
 */
export interface AcceleratorResourceRequest {
  /** The neutral device class (e.g. "gpu", "tensor-accelerator"). */
  readonly acceleratorClass: AcceleratorClass;
  /** Minimum devices per replica (1..1024). */
  readonly deviceCount: number;
  /** Minimum per-device memory in MiB (0 = unbounded). */
  readonly perDeviceMemoryMiB: number;
  /** Required device interconnect. */
  readonly interconnect: InterconnectClass;
  /** Optional minimum neutral capability version (semver). */
  readonly minVersion?: string;
}

// ---------------------------------------------------------------------------
// The explicit, auditable resource estimate (implementation requirement)
// ---------------------------------------------------------------------------

/**
 * The full resource estimate of one workload. EVERY field is required,
 * bounded and numeric — the budget authority reserves against
 * `estimatedCostMicroUsd` and the audit trail reads this exact shape.
 */
export interface TrainingResourceEstimate {
  readonly accelerator: AcceleratorResourceRequest;
  /** Fleet replicas (large-batch workloads; 1..1024). */
  readonly replicaCount: number;
  /** Host/coordination CPU estimate in milli-cores (1..64000). */
  readonly cpuMilliCores: number;
  /** Host/coordination memory estimate in MiB (4..262144). */
  readonly memoryMiB: number;
  /** Estimated wall-clock duration in ms (1..2_592_000_000 = 30 days). */
  readonly estimatedDurationMs: number;
  /** Estimated total cost, integer micro-USD string (>= 1 for training —
   *  paid compute is never free; the budget authority reserves this). */
  readonly estimatedCostMicroUsd: string;
}

// ---------------------------------------------------------------------------
// Lineage (ACC-003 / criterion 5 — dataset/code/config/checkpoint/output)
// ---------------------------------------------------------------------------

/**
 * The lineage references of one workload: everything the run consumes
 * and produces, as OPAQUE artifact references (content-addressed by the
 * artifacts authority — host-shaped paths are rejected, raw values
 * never cross). Checkpoints reference their parent checkpoint lineage,
 * outputs reference the producing workload identity.
 */
export interface WorkloadLineageRefs {
  /** Dataset artifact references (read). */
  readonly datasetRefs: readonly string[];
  /** Code/program artifact references (read). */
  readonly codeRefs: readonly string[];
  /** Configuration artifact references (read). */
  readonly configRefs: readonly string[];
  /** Checkpoint references this run resumes from (read; empty on a cold start). */
  readonly checkpointRefs: readonly string[];
  /** Prior output references consumed as inputs (read). */
  readonly parentOutputRefs: readonly string[];
}

export const MAX_LINEAGE_REFS = 32;
export const MAX_TOTAL_LINEAGE_REFS = 128;

// ---------------------------------------------------------------------------
// The workload specification
// ---------------------------------------------------------------------------

/**
 * The full provider-neutral workload specification. `task` reuses the
 * sandbox task discipline (argv + explicit non-secret public env — the
 * same admission-time sanitization applies); `checkpointIntervalSteps`
 * drives checkpoint emission; `maxRetryAttempts` bounds the retry
 * ladder.
 */
export interface TrainingWorkloadSpec {
  readonly workloadKind: TrainingWorkloadKind;
  readonly task: SandboxTask;
  readonly resource: TrainingResourceEstimate;
  readonly lineage: WorkloadLineageRefs;
  /** Emit a checkpoint every N completed steps (1..1_000_000). */
  readonly checkpointIntervalSteps: number;
  /** Maximum retry attempts after failure (0..16). */
  readonly maxRetryAttempts: number;
}

// ---------------------------------------------------------------------------
// Workload lifecycle (subordinate bookkeeping — never an execution system)
// ---------------------------------------------------------------------------

/**
 * The training workload lifecycle. `failed` is terminal for an attempt
 * but retryable through the guarded retry transition (attempts+1); the
 * workload identity (row + execution binding) is STABLE across
 * retry/resume — the crash-recovery discipline.
 */
export const TRAINING_WORKLOAD_STATUSES = [
  "denied",
  "admitted",
  "allocating",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TrainingWorkloadStatus = (typeof TRAINING_WORKLOAD_STATUSES)[number];

export const TERMINAL_TRAINING_STATUSES = ["denied", "completed", "cancelled"] as const;

export function isTrainingWorkloadStatus(value: string): value is TrainingWorkloadStatus {
  return (TRAINING_WORKLOAD_STATUSES as readonly string[]).includes(value);
}

export function isTerminalTrainingStatus(status: TrainingWorkloadStatus): boolean {
  return (TERMINAL_TRAINING_STATUSES as readonly string[]).includes(status);
}

/** The legal row transitions (guarded in the store; enforced physically in PG). */
export const TRAINING_WORKLOAD_TRANSITIONS: Readonly<
  Record<TrainingWorkloadStatus, readonly TrainingWorkloadStatus[]>
> = {
  denied: [],
  admitted: ["allocating", "cancelled"],
  allocating: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["allocating"],
  cancelled: [],
};

export function canTransitionTrainingWorkload(
  from: TrainingWorkloadStatus,
  to: TrainingWorkloadStatus,
): boolean {
  return TRAINING_WORKLOAD_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Admission/outcome vocabularies (the training axis)
// ---------------------------------------------------------------------------

/** Admission denial classes — exactly the admission authorities. */
export const TRAINING_DENIAL_CLASSES = ["policy", "budget", "capability"] as const;

export type TrainingDenialClass = (typeof TRAINING_DENIAL_CLASSES)[number];

export type TrainingDenialCode = "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE";

/** Training-axis failure classes. */
export const TRAINING_FAILURE_CLASSES = [
  "workload-failure",
  "timeout",
  "substrate-error",
  "substrate-unavailable",
  "convergence-loss", // the honest unknown-outcome crash state (§14)
] as const;

export type TrainingFailureClass = (typeof TRAINING_FAILURE_CLASSES)[number];

export function isTrainingFailureClass(value: string): value is TrainingFailureClass {
  return (TRAINING_FAILURE_CLASSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The immutable runtime metadata (write-once admitted snapshot)
// ---------------------------------------------------------------------------

/**
 * The IMMUTABLE admitted snapshot: exactly what was admitted, by which
 * authorities, under which substrate selection. Dispatch and resume
 * always execute THIS snapshot — never a re-read of the (possibly
 * since-retired) substrate. Persisted write-once.
 */
export interface TrainingRuntimeMetadata {
  readonly workloadKind: TrainingWorkloadKind;
  readonly task: SandboxTask;
  readonly resource: TrainingResourceEstimate;
  readonly lineage: WorkloadLineageRefs;
  readonly checkpointIntervalSteps: number;
  readonly maxRetryAttempts: number;
  /** The neutral substrate selection evidence (capability authority). */
  readonly substrate: {
    readonly substrateId: string;
    readonly version: string;
    readonly adapterRef: string;
    readonly digest: string;
    readonly executionCapabilityId: string;
  } | null;
  /** Durable policy-admission provenance (the authority's evidence). */
  readonly policyEvidence: {
    readonly policySetId: string;
    readonly policySetVersion: number;
    readonly policyContentHash: string;
    readonly restrictionSetDigest: string;
  } | null;
  /** The capability satisfaction evidence (claim id@version + evidence). */
  readonly capabilitySatisfaction: string | null;
  /** The budget operation id (the reservation's stable discriminator). */
  readonly budgetOperationId: string | null;
}

// ---------------------------------------------------------------------------
// The training workload record
// ---------------------------------------------------------------------------

/**
 * One governed training/batch workload. The release dimension starts
 * null and can only be set by the verification-gate operation (a
 * completed-but-unverified workload is NEVER a released model).
 */
export interface TrainingWorkloadRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadKey: string;
  readonly requestFingerprint: string;
  readonly workloadKind: TrainingWorkloadKind;
  readonly status: TrainingWorkloadStatus;
  readonly runtimeMetadata: TrainingRuntimeMetadata;
  readonly denialClass: TrainingDenialClass | null;
  readonly denialCode: TrainingDenialCode | null;
  readonly denialReason: string | null;
  /** Monotonic attempt ledger (1 = first attempt; retry/resume bump). */
  readonly attempts: number;
  readonly failureClass: TrainingFailureClass | null;
  readonly failureMessage: string | null;
  readonly outputArtifactDigest: string | null;
  readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
  readonly usageMicroUsd: string | null;
  readonly budgetOperationId: string | null;
  /** The substrate allocation evidence (set by the allocation step). */
  readonly allocationId: string | null;
  readonly substrateId: string | null;
  readonly adapterRef: string | null;
  /** The resume point: the content-digest identity of the newest checkpoint. */
  readonly lastCheckpointIdentity: string | null;
  /** The verification-release boundary (ACC-003): null until the
   *  verification authority PASSES the output; never set by compute. */
  readonly verifiedReleaseAt: string | null;
  readonly verificationEvaluationId: string | null;
  readonly ledgerAdmittedSequence: number | null;
  readonly ledgerCompletedSequence: number | null;
  readonly createdAt: string;
  readonly allocatedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
}

export interface TrainingCreateInput {
  readonly executionId: string;
  readonly spec: TrainingWorkloadSpec;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MICRO_USD_PATTERN = /^\d{1,19}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TRAINING_RESOURCE_BOUNDS = {
  deviceCount: { min: 1, max: 1024 },
  perDeviceMemoryMiB: { min: 0, max: 1_048_576 },
  replicaCount: { min: 1, max: 1024 },
  cpuMilliCores: { min: 1, max: 64_000 },
  memoryMiB: { min: 4, max: 262_144 },
  estimatedDurationMs: { min: 1, max: 2_592_000_000 },
  checkpointIntervalSteps: { min: 1, max: 1_000_000 },
  maxRetryAttempts: { min: 0, max: 16 },
} as const;

export interface WorkloadValidation {
  readonly valid: boolean;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}

/** The mutable issue accumulator (the validation helpers' output). */
type IssueAccumulator = { field: string; reason: string }[];

function requireInteger(
  value: unknown,
  field: string,
  bounds: { readonly min: number; readonly max: number },
  issues: IssueAccumulator,
): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ field, reason: "must be an integer" });
    return;
  }
  if (value < bounds.min || value > bounds.max) {
    issues.push({ field, reason: `must be between ${bounds.min} and ${bounds.max}` });
  }
}

function validateLineageRefs(
  refs: readonly string[],
  field: string,
  issues: IssueAccumulator,
): void {
  if (!Array.isArray(refs)) {
    issues.push({ field, reason: "must be an array of opaque references" });
    return;
  }
  if (refs.length > MAX_LINEAGE_REFS) {
    issues.push({ field, reason: `at most ${MAX_LINEAGE_REFS} references are allowed` });
  }
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.length === 0) {
      issues.push({ field, reason: "references must be non-empty strings" });
      continue;
    }
    if (!REF_PATTERN.test(ref)) {
      issues.push({ field, reason: `"${ref}" is not a valid opaque reference` });
      continue;
    }
    if (refLooksLikeHostPath(ref)) {
      issues.push({
        field,
        reason: `"${ref}" looks like a host path; lineage references are opaque content-addressed identifiers`,
      });
    }
  }
}

/**
 * Validate a complete workload specification. Pure and total: every
 * issue is typed and field-qualified; the resource estimate is
 * EXPLICIT (no defaults are ever filled in here).
 */
export function validateTrainingWorkloadSpec(spec: TrainingWorkloadSpec): WorkloadValidation {
  const issues: IssueAccumulator = [];
  if (spec === null || typeof spec !== "object") {
    return { valid: false, issues: [{ field: "spec", reason: "spec must be an object" }] };
  }
  if (!isTrainingWorkloadKind(spec.workloadKind)) {
    issues.push({
      field: "workloadKind",
      reason: `workloadKind must be one of ${TRAINING_WORKLOAD_KINDS.join("|")}`,
    });
  }
  const resource = spec.resource;
  if (resource === null || typeof resource !== "object") {
    return {
      valid: false,
      issues: [...issues, { field: "resource", reason: "resource estimate is required" }],
    };
  }
  const accelerator = resource.accelerator;
  if (accelerator === null || typeof accelerator !== "object") {
    issues.push({
      field: "resource.accelerator",
      reason: "an accelerator resource request is required",
    });
  } else {
    if (!isAcceleratorClass(accelerator.acceleratorClass)) {
      issues.push({
        field: "resource.accelerator.acceleratorClass",
        reason: `must be one of ${ACCELERATOR_CLASSES.join("|")} (provider-neutral device classes only)`,
      });
    }
    if (!isInterconnectClass(accelerator.interconnect)) {
      issues.push({
        field: "resource.accelerator.interconnect",
        reason: `must be one of ${INTERCONNECT_CLASSES.join("|")}`,
      });
    }
    requireInteger(
      accelerator.deviceCount,
      "resource.accelerator.deviceCount",
      TRAINING_RESOURCE_BOUNDS.deviceCount,
      issues,
    );
    requireInteger(
      accelerator.perDeviceMemoryMiB,
      "resource.accelerator.perDeviceMemoryMiB",
      TRAINING_RESOURCE_BOUNDS.perDeviceMemoryMiB,
      issues,
    );
    if (
      accelerator.minVersion !== undefined &&
      (typeof accelerator.minVersion !== "string" || !SEMVER_PATTERN.test(accelerator.minVersion))
    ) {
      issues.push({
        field: "resource.accelerator.minVersion",
        reason: "must be major.minor.patch numerics",
      });
    }
  }
  requireInteger(
    resource.replicaCount,
    "resource.replicaCount",
    TRAINING_RESOURCE_BOUNDS.replicaCount,
    issues,
  );
  requireInteger(
    resource.cpuMilliCores,
    "resource.cpuMilliCores",
    TRAINING_RESOURCE_BOUNDS.cpuMilliCores,
    issues,
  );
  requireInteger(
    resource.memoryMiB,
    "resource.memoryMiB",
    TRAINING_RESOURCE_BOUNDS.memoryMiB,
    issues,
  );
  requireInteger(
    resource.estimatedDurationMs,
    "resource.estimatedDurationMs",
    TRAINING_RESOURCE_BOUNDS.estimatedDurationMs,
    issues,
  );
  if (
    typeof resource.estimatedCostMicroUsd !== "string" ||
    !MICRO_USD_PATTERN.test(resource.estimatedCostMicroUsd)
  ) {
    issues.push({
      field: "resource.estimatedCostMicroUsd",
      reason:
        "must be a positive integer micro-USD string (resource estimates are explicit and auditable)",
    });
  } else if (resource.estimatedCostMicroUsd === "0") {
    issues.push({
      field: "resource.estimatedCostMicroUsd",
      reason:
        "training compute is paid compute; a zero estimate is not an admissible resource estimate",
    });
  }
  const lineage = spec.lineage;
  if (lineage === null || typeof lineage !== "object") {
    issues.push({ field: "lineage", reason: "lineage references are required" });
  } else {
    validateLineageRefs(lineage.datasetRefs, "lineage.datasetRefs", issues);
    validateLineageRefs(lineage.codeRefs, "lineage.codeRefs", issues);
    validateLineageRefs(lineage.configRefs, "lineage.configRefs", issues);
    validateLineageRefs(lineage.checkpointRefs, "lineage.checkpointRefs", issues);
    validateLineageRefs(lineage.parentOutputRefs, "lineage.parentOutputRefs", issues);
    const total =
      (lineage.datasetRefs?.length ?? 0) +
      (lineage.codeRefs?.length ?? 0) +
      (lineage.configRefs?.length ?? 0) +
      (lineage.checkpointRefs?.length ?? 0) +
      (lineage.parentOutputRefs?.length ?? 0);
    if (total > MAX_TOTAL_LINEAGE_REFS) {
      issues.push({
        field: "lineage",
        reason: `at most ${MAX_TOTAL_LINEAGE_REFS} total lineage references`,
      });
    }
    if (lineage.datasetRefs.length === 0 || lineage.codeRefs.length === 0) {
      issues.push({
        field: "lineage",
        reason:
          "training workloads declare at least one dataset and one code reference (reproducible lineage)",
      });
    }
  }
  requireInteger(
    spec.checkpointIntervalSteps,
    "checkpointIntervalSteps",
    TRAINING_RESOURCE_BOUNDS.checkpointIntervalSteps,
    issues,
  );
  requireInteger(
    spec.maxRetryAttempts,
    "maxRetryAttempts",
    TRAINING_RESOURCE_BOUNDS.maxRetryAttempts,
    issues,
  );
  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Idempotency: the workload key + request fingerprint
// ---------------------------------------------------------------------------

/** The idempotency key shape (caller-provided opaque printable string). */
export const TRAINING_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

/**
 * Canonical request fingerprint (deterministic JSON, sorted keys — the
 * idempotency discriminator): the SAME logical request replays the SAME
 * durable outcome; a different request under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export function trainingRequestFingerprint(
  applicationId: string,
  executionId: string,
  actorId: string,
  input: TrainingCreateInput,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return value;
  };
  return JSON.stringify([
    "training.submit",
    applicationId,
    executionId,
    actorId,
    canonical(input.spec),
  ]);
}

// ---------------------------------------------------------------------------
// Durable, recoverable operation state (the WORK-024/0028 crash standard)
// ---------------------------------------------------------------------------

/** The governed training operation kinds (WORK-030 vocabulary). */
export const TRAINING_OPERATION_KINDS = [
  "submit",
  "allocate",
  "run",
  "checkpoint",
  "cancel",
  "resume",
  "retry",
  "publish-output",
  "release",
] as const;

export type TrainingOperationKind = (typeof TRAINING_OPERATION_KINDS)[number];

export const TRAINING_OPERATION_STATUSES = ["pending", "completed", "failed"] as const;
export type TrainingOperationStatus = (typeof TRAINING_OPERATION_STATUSES)[number];

export function isTrainingOperationKind(value: string): value is TrainingOperationKind {
  return (TRAINING_OPERATION_KINDS as readonly string[]).includes(value);
}

/**
 * One durable operation record: PENDING -> COMPLETED | FAILED with the
 * stable operation key arbitration (first invocation inserts PENDING;
 * later invocations return the existing row with `attempts` bumped),
 * the request fingerprint (key reuse fails closed) and the bounded
 * stage checkpoint (the past-the-point-of-no-return facts).
 */
export interface TrainingOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadId: string | null;
  readonly operationKind: TrainingOperationKind;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly status: TrainingOperationStatus;
  readonly attempts: number;
  readonly stage: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** The stable operation-key scheme (always workload/execution-scoped). */
export function trainingOperationKey(kind: TrainingOperationKind, discriminator: string): string {
  return `trop:${kind}:${discriminator}`;
}

/** Discriminator composition helper (workload-scoped by construction). */
export function workloadScopedDiscriminator(workloadKey: string, suffix: string): string {
  return `${workloadKey}:${suffix}`;
}

// ---------------------------------------------------------------------------
// Checkpoints (ACC-003 / criterion 4 — immutable, content/lineage
// addressable, stable execution identity)
// ---------------------------------------------------------------------------

/**
 * The structural contents of one training checkpoint. Every field is a
 * required, typed column of the restart contract: the checkpoint binds
 * to the EXISTING execution + workload identity (there is no second
 * execution identity), carries the full lineage (dataset/code/config/
 * parent checkpoints), the step position, the metrics digest and the
 * material substrate facts the resume materiality rule compares.
 */
export interface TrainingCheckpointContents {
  readonly executionId: string;
  readonly workloadId: string;
  readonly workloadKey: string;
  /** Per-workload monotonic sequence (1..N, write-once per sequence). */
  readonly checkpointSequence: number;
  /** The completed step position this checkpoint restarts from (>= 1). */
  readonly stepPosition: number;
  readonly lineage: WorkloadLineageRefs;
  /** sha256 hex over the canonical metrics record at checkpoint time. */
  readonly metricsDigest: string;
  /** The neutral substrate identity the run was executing on. */
  readonly substrateId: string;
  readonly resourceClass: string;
  readonly recordedBy: string;
}

/** The durable checkpoint record (write-once; identity = content digest). */
export interface TrainingCheckpointRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly workloadId: string;
  readonly workloadKey: string;
  readonly checkpointSequence: number;
  readonly contents: TrainingCheckpointContents;
  /** sha256 hex over `canonicalTrainingCheckpointJson(contents)` — THE identity. */
  readonly contentDigest: string;
  readonly createdAt: string;
}

const CHECKPOINT_UUID_OR_KEY = (value: string): boolean =>
  UUID_PATTERN.test(value) || TRAINING_KEY_PATTERN.test(value);

/** Structural validation — malformed contents fail closed, typed. */
export function validateTrainingCheckpointContents(contents: TrainingCheckpointContents): void {
  if (typeof contents.executionId !== "string" || !UUID_PATTERN.test(contents.executionId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a valid executionId (the existing execution identity)",
    });
  }
  if (typeof contents.workloadId !== "string" || !UUID_PATTERN.test(contents.workloadId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a valid workloadId (the stable workload identity)",
    });
  }
  if (typeof contents.workloadKey !== "string" || !CHECKPOINT_UUID_OR_KEY(contents.workloadKey)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a valid workloadKey (the stable idempotency key)",
    });
  }
  if (!Number.isInteger(contents.checkpointSequence) || contents.checkpointSequence < 1) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a positive integer checkpointSequence",
    });
  }
  if (!Number.isInteger(contents.stepPosition) || contents.stepPosition < 1) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a positive integer stepPosition",
    });
  }
  const lineageIssues: IssueAccumulator = [];
  validateLineageRefs(contents.lineage?.datasetRefs ?? [], "lineage.datasetRefs", lineageIssues);
  validateLineageRefs(contents.lineage?.codeRefs ?? [], "lineage.codeRefs", lineageIssues);
  validateLineageRefs(contents.lineage?.configRefs ?? [], "lineage.configRefs", lineageIssues);
  validateLineageRefs(
    contents.lineage?.checkpointRefs ?? [],
    "lineage.checkpointRefs",
    lineageIssues,
  );
  if (lineageIssues.length > 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: `checkpoint lineage is invalid: ${lineageIssues[0]?.field} ${lineageIssues[0]?.reason}`,
    });
  }
  if (
    typeof contents.metricsDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(contents.metricsDigest)
  ) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a 64-hex metricsDigest",
    });
  }
  if (typeof contents.substrateId !== "string" || contents.substrateId.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a non-empty substrateId",
    });
  }
  if (typeof contents.resourceClass !== "string" || contents.resourceClass.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a non-empty resourceClass",
    });
  }
  if (typeof contents.recordedBy !== "string" || contents.recordedBy.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a non-empty recordedBy",
    });
  }
}

/** Deterministic key-recursive canonical JSON (the digest base). */
function canonicalJsonSorted(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(canonical);
    }
    if (input !== null && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

/**
 * The canonical serialization of the checkpoint MATERIAL contents (digest
 * base). The ledger POSITION (`checkpointSequence`) is deliberately NOT
 * part of the canonical form: the identity is the address of "this
 * workload at this step with these facts", not of "position N in the
 * journal" — a re-driven run (crash recovery) or a later attempt
 * re-emitting the same material checkpoint converges on the SAME
 * identity wherever it lands, while the per-workload gapless sequence
 * (the migration's gate) keeps the journal ordered. (v2: v1 covered the
 * sequence too, which made a retried attempt's re-emitted checkpoints
 * collide on the sequence unique constraint instead of continuing the
 * journal — a defect this wave's real-PG tier found.)
 */
export function canonicalTrainingCheckpointJson(contents: TrainingCheckpointContents): string {
  return canonicalJsonSorted({
    executionId: contents.executionId,
    workloadId: contents.workloadId,
    workloadKey: contents.workloadKey,
    stepPosition: contents.stepPosition,
    lineage: contents.lineage,
    metricsDigest: contents.metricsDigest,
    substrateId: contents.substrateId,
    resourceClass: contents.resourceClass,
    recordedBy: contents.recordedBy,
  });
}

/** The digest input handed to the injected digest function. */
export function trainingCheckpointDigestInput(contents: TrainingCheckpointContents): string {
  return `zeck:training-checkpoint:v2:${canonicalTrainingCheckpointJson(contents)}`;
}

/**
 * The CHECKPOINT IDENTITY: the sha256 content digest — immutable,
 * content-addressable (find by digest) and lineage-addressable (the
 * digest covers the full lineage refs, so a checkpoint is the unique
 * address of "this workload at this step over this lineage"). The ledger
 * position (checkpointSequence) is NOT part of the identity — identical
 * material facts are ONE durable checkpoint wherever the journal places
 * them (the crash/retry convergence contract).
 */
export function trainingCheckpointIdentity(
  contents: TrainingCheckpointContents,
  digest: (input: string) => string,
): string {
  return digest(trainingCheckpointDigestInput(contents));
}

/**
 * INTEGRITY VERIFICATION (the resume requirement): recompute the
 * identity over the record's contents and compare against the stored
 * digest. Returns the failure reason, or null when intact.
 */
export function trainingCheckpointIntegrityFailure(
  record: Pick<
    TrainingCheckpointRecord,
    "contents" | "contentDigest" | "workloadId" | "executionId"
  >,
  digest: (input: string) => string,
): string | null {
  if (record.contents.workloadId !== record.workloadId) {
    return "checkpoint identity mismatch: contents do not bind to the checkpointed workload";
  }
  if (record.contents.executionId !== record.executionId) {
    return "checkpoint identity mismatch: contents do not bind to the checkpointed execution";
  }
  const recomputed = trainingCheckpointIdentity(record.contents, digest);
  if (recomputed !== record.contentDigest) {
    return "checkpoint content digest mismatch: the durable checkpoint is corrupt or was tampered with";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The resume materiality rule (re-admission discipline, WORK-028 LNG-003)
// ---------------------------------------------------------------------------

/** The material admission facts the resume materiality rule compares. */
export interface TrainingResumeFacts {
  readonly workloadKind: TrainingWorkloadKind;
  readonly substrateId: string;
  readonly resourceClass: string;
  readonly estimatedCostMicroUsd: string;
  readonly requiredCapabilities: readonly string[];
}

/**
 * The material-change dimensions. Only the dimensions the CHECKPOINT
 * CONTENTS can witness are comparable (the checkpoint is the durable
 * admitted-fact snapshot the rule reads): the neutral substrate identity
 * and the neutral resource class. `workloadKind`/`estimatedCostMicroUsd`
 * and the capability identity ride the immutable runtime metadata + the
 * substrate selection digest — a changed substrate selection ALWAYS
 * changes `substrateId`, so the rule still catches it; a capability
 * change without a substrate change is not observable from the
 * checkpoint and is NOT claimed as a dimension (over-claiming dead
 * dimensions was a review-found defect — the exported vocabulary now
 * states exactly what the rule compares).
 */
export const TRAINING_MATERIAL_CHANGE_DIMENSIONS = ["substrateId", "resourceClass"] as const;

export type TrainingMaterialChangeDimension = (typeof TRAINING_MATERIAL_CHANGE_DIMENSIONS)[number];

/**
 * THE MATERIALITY RULE: a resume is MATERIALLY CHANGED when any
 * admission-relevant fact the checkpoint can witness differs from the
 * checkpointed fact — a materially changed resume re-enters the CURRENT
 * policy controls; an UNCHANGED resume (a crash-recovery retry of the
 * same admitted substrate/resource facts) skips re-admission and resumes
 * from the checkpoint with the SAME execution identity.
 */
export function trainingMaterialChangeBetween(
  checkpoint: TrainingCheckpointContents,
  facts: TrainingResumeFacts,
): readonly TrainingMaterialChangeDimension[] {
  const changed: TrainingMaterialChangeDimension[] = [];
  if (checkpoint.substrateId !== facts.substrateId) {
    changed.push("substrateId");
  }
  if (checkpoint.resourceClass !== facts.resourceClass) {
    changed.push("resourceClass");
  }
  return changed;
}

// ---------------------------------------------------------------------------
// The run lease (single-owner discipline, the WORK-028 lease pattern)
// ---------------------------------------------------------------------------

/**
 * THE single-owner lease of a live training run: exactly ONE owner is
 * authoritative at a time; epochs are MONOTONIC (acquiring a free
 * lease takes epoch = prior + 1, so a stale worker's (owner, epoch)
 * pair can never match the current lease again); every side-effecting
 * operation carries a lease-validity guard derived here (fail closed).
 */
export interface TrainingRunLeaseRecord {
  readonly workloadId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly lastHeartbeatAt: string;
  readonly heartbeatCount: number;
  readonly releasedAt: string | null;
  readonly releaseCause: string | null;
}

export type TrainingLeaseState = "held" | "expired" | "released";

export function classifyTrainingLease(
  lease: TrainingRunLeaseRecord,
  at: string,
): TrainingLeaseState {
  if (lease.releasedAt !== null) {
    return "released";
  }
  return lease.expiresAt > at ? "held" : "expired";
}

/** The ownership claim a worker presents to commit side effects. */
export interface TrainingLeaseGuard {
  readonly ownerId: string;
  readonly epoch: number;
}

export interface TrainingLeaseRejection {
  readonly code: "EXPIRED" | "INVALID_STATE_TRANSITION";
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The lease-validity guard: the typed rejection when this worker may
 * NOT commit side effects, or null when the lease is live and owned by
 * exactly this (ownerId, epoch). FAIL CLOSED on every mismatch class.
 */
export function trainingLeaseGuardRejection(
  lease: TrainingRunLeaseRecord | null,
  guard: TrainingLeaseGuard,
  at: string,
): TrainingLeaseRejection | null {
  if (lease === null) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: "no run lease is held; training side effects require a live run lease",
      details: { guard },
    };
  }
  if (lease.releasedAt !== null) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: `the run lease was released (${lease.releaseCause ?? "released"}); side effects require a live lease`,
      details: { ownerId: lease.ownerId, epoch: lease.epoch, releasedAt: lease.releasedAt },
    };
  }
  if (lease.epoch !== guard.epoch) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: `run lease epoch mismatch: the lease is at epoch ${lease.epoch}; a stale worker at epoch ${guard.epoch} is not authoritative`,
      details: { currentEpoch: lease.epoch, workerEpoch: guard.epoch, ownerId: lease.ownerId },
    };
  }
  if (lease.ownerId !== guard.ownerId) {
    return {
      code: "INVALID_STATE_TRANSITION",
      reason: `the run lease is held by another owner (${lease.ownerId}); lease conflicts fail closed`,
      details: { leaseOwner: lease.ownerId, worker: guard.ownerId, epoch: lease.epoch },
    };
  }
  if (lease.expiresAt <= at) {
    return {
      code: "EXPIRED",
      reason: `the run lease expired at ${lease.expiresAt}; stale workers cannot commit side effects`,
      details: { ownerId: lease.ownerId, epoch: lease.epoch, expiresAt: lease.expiresAt },
    };
  }
  return null;
}

/** Throw the typed PlatformError for a lease guard rejection. */
export function throwTrainingLeaseRejection(
  workloadId: string,
  rejection: TrainingLeaseRejection,
): never {
  throw new PlatformError({
    code: rejection.code,
    message: rejection.reason,
    details: { ...rejection.details, workloadId },
  });
}

/** The governed release causes (auditable vocabulary). */
export const TRAINING_LEASE_RELEASE_CAUSES = [
  "run-completed",
  "run-failed",
  "worker-released",
  "cancelled",
] as const;

export type TrainingLeaseReleaseCause = (typeof TRAINING_LEASE_RELEASE_CAUSES)[number];
