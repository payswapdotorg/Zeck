/**
 * Computational substrate domain (capabilities module domain; WORK-031,
 * CSX-001/CSX-002, ADR-0016).
 *
 * THE provider-neutral `ComputationalSubstrate` contract: a substrate
 * is a CAPABILITY and an EXECUTION TARGET — never a new top-level
 * authority (ADR-0016 invariant 2). Every dimension the ADR demands
 * is declared ONCE, validated fail-closed, and published through the
 * EXISTING capability registry (the substrate's execution capability
 * claim) plus a durable substrate record:
 *
 *   identity        → `substrateId` + `version` (write-once per version)
 *   workload classes → the frozen CSX-002 vocabulary the substrate
 *                      supports (interactive, realtime, asynchronous,
 *                      batch, training-evaluation, edge, embodied,
 *                      specialized-accelerator)
 *   modality        → neutral modality atoms (text/audio/image/video/
 *                      document — the deployment-fabric vocabulary)
 *   latency         → the latency class the substrate can serve
 *   resource        → the explicit resource profile (NEUTRAL units;
 *                      never vendor SKUs)
 *   isolation       → the isolation class (the policies ladder)
 *   side effects    → the side-effect classes the substrate may produce
 *
 * Vendor specifics NEVER cross this contract: `providerRef` is an
 * OPAQUE reference to the replaceable adapter behind which the vendor
 * lives (CSX-004). A substrate CLAIM is distinct from AUTHORIZATION
 * to use it (the work order's implementation requirement): claims are
 * metadata; policy, capability, budget and tenant admission happen in
 * THEIR authorities at planning/execution time — unchanged.
 */

// ---------------------------------------------------------------------------
// CSX-002: the workload-class vocabulary (frozen; declared once here,
// consumed by planning through the public barrel)
// ---------------------------------------------------------------------------

/**
 * The ADR-0016 workload-class taxonomy, frozen: the Execution-compatible
 * classes every substrate/plan/task reasons over. Adding a class is a
 * vocabulary change (a reviewed extension), never a silent one.
 */
export const WORKLOAD_CLASSES = [
  "interactive",
  "realtime",
  "asynchronous",
  "batch",
  "training-evaluation",
  "edge",
  "embodied",
  "specialized-accelerator",
] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export function isWorkloadClass(value: string): value is WorkloadClass {
  return (WORKLOAD_CLASSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// CSX-001: the substrate contract vocabulary
// ---------------------------------------------------------------------------

/** Substrate latency classes (the capabilities-side vocabulary). */
export const SUBSTRATE_LATENCY_CLASSES = [
  "realtime",
  "interactive",
  "asynchronous",
  "batch",
] as const;
export type SubstrateLatencyClass = (typeof SUBSTRATE_LATENCY_CLASSES)[number];

/** Substrate modality atoms (neutral, mirrors the deployments vocabulary). */
export const SUBSTRATE_MODALITIES = ["text", "audio", "image", "video", "document"] as const;
export type SubstrateModality = (typeof SUBSTRATE_MODALITIES)[number];

/** Side-effect classes (the shared vocabulary). */
export const SUBSTRATE_SIDE_EFFECT_CLASSES = ["none", "read-only", "write-external"] as const;
export type SubstrateSideEffectClass = (typeof SUBSTRATE_SIDE_EFFECT_CLASSES)[number];

/**
 * The isolation class a substrate provides — ALIGNED with the policies
 * module's frozen isolation ladder (`ISOLATION_LEVELS`), expressed as
 * the substrate's own copy of the ladder semantics (the capabilities
 * module does not import policies — the ladder is mirrored by value
 * and pinned by tests, the same way learning mirrors the tools field
 * vocabulary).
 */
export const SUBSTRATE_ISOLATION_CLASSES = [
  "none",
  "process",
  "container",
  "microvm",
  "vm",
  "customer-runner",
] as const;
export type SubstrateIsolationClass = (typeof SUBSTRATE_ISOLATION_CLASSES)[number];

/** The explicit neutral resource profile (never vendor SKUs). */
export interface SubstrateResourceProfile {
  /** CPU estimate in milli-cores per unit of work (0 = unbounded claim). */
  readonly cpuMilliCores: number;
  /** Memory estimate in MiB. */
  readonly memoryMiB: number;
  /**
   * Estimated wall-clock per unit in milliseconds (0 = no estimate).
   * Bound: 1..86400000 when non-zero.
   */
  readonly estimatedDurationMs: number;
  /** Estimated cost per unit, integer micro-USD string ("0" = uncosted). */
  readonly estimatedCostMicroUsd: string;
}

/** The substrate descriptor (the publishable closed shape). */
export interface ComputationalSubstrateInput {
  readonly substrateId: string;
  readonly version: string;
  /** The workload classes this substrate can serve (>= 1). */
  readonly workloadClasses: readonly WorkloadClass[];
  /** Neutral modality atoms the substrate produces/consumes. */
  readonly modalities: readonly SubstrateModality[];
  readonly latencyClass: SubstrateLatencyClass;
  readonly resource: SubstrateResourceProfile;
  readonly isolation: SubstrateIsolationClass;
  readonly sideEffectClasses: readonly SubstrateSideEffectClass[];
  /**
   * The EXECUTION capability this substrate satisfies: a neutral
   * capability identity published into the EXISTING registry (kind
   * "runtime") — substrate selection requires this claim to resolve.
   */
  readonly executionCapability: { readonly id: string; readonly minVersion?: string };
  /**
   * OPAQUE reference to the replaceable adapter serving this substrate
   * (CSX-004): a neutral identifier, never a vendor name, never an SDK
   * handle — the adapter binding is a composition-root choice.
   */
  readonly adapterRef: string;
  readonly description: string | null;
}

/** The durable substrate record (immutable versioned + lifecycle). */
export interface ComputationalSubstrateRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly substrateId: string;
  readonly version: string;
  readonly workloadClasses: readonly WorkloadClass[];
  readonly modalities: readonly SubstrateModality[];
  readonly latencyClass: SubstrateLatencyClass;
  readonly resource: SubstrateResourceProfile;
  readonly isolation: SubstrateIsolationClass;
  readonly sideEffectClasses: readonly SubstrateSideEffectClass[];
  readonly executionCapability: { readonly id: string; readonly minVersion?: string };
  readonly adapterRef: string;
  readonly description: string | null;
  readonly digest: string;
  readonly status: SubstrateLifecycleStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The substrate lifecycle (small, subordinate; the registry pattern). */
export const SUBSTRATE_LIFECYCLE_STATUSES = ["available", "suspended", "retired"] as const;
export type SubstrateLifecycleStatus = (typeof SUBSTRATE_LIFECYCLE_STATUSES)[number];

export function isSubstrateLifecycleStatus(value: string): value is SubstrateLifecycleStatus {
  return (SUBSTRATE_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

/** The legal substrate lifecycle transitions (retired terminal). */
export const SUBSTRATE_LIFECYCLE_TRANSITIONS: Readonly<
  Record<SubstrateLifecycleStatus, readonly SubstrateLifecycleStatus[]>
> = {
  available: ["suspended", "retired"],
  suspended: ["available", "retired"],
  retired: [],
};

export function canTransitionSubstrate(
  from: SubstrateLifecycleStatus,
  to: SubstrateLifecycleStatus,
): boolean {
  return SUBSTRATE_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export type SubstrateValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const ADAPTER_REF_PATTERN = /^[a-z0-9][a-z0-9.-]{0,199}$/;
const MICRO_USD_PATTERN = /^\d{1,16}$/;
const MAX_DESCRIPTION = 2000;

/** Raw-secret VALUE patterns (the WORK-011 nine-pattern discipline). */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export function substrateContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Pure, fail-closed validation of a substrate descriptor. Vocabularies
 * are frozen, arrays bounded and duplicate-free, the resource profile
 * explicit and neutral, free text secret-scanned — a malformed
 * declaration never becomes durable state.
 */
export function validateComputationalSubstrate(input: unknown): SubstrateValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, reason: "substrate input must be an object" };
  }
  const s = input as ComputationalSubstrateInput;
  if (typeof s.substrateId !== "string" || !IDENTITY_PATTERN.test(s.substrateId)) {
    return { valid: false, reason: "substrateId must be a lowercase hyphen-dashed identifier" };
  }
  if (typeof s.version !== "string" || !VERSION_PATTERN.test(s.version)) {
    return { valid: false, reason: "version must be major.minor.patch numerics" };
  }
  if (!Array.isArray(s.workloadClasses) || s.workloadClasses.length === 0) {
    return { valid: false, reason: "workloadClasses must declare at least one class" };
  }
  if (new Set(s.workloadClasses).size !== s.workloadClasses.length) {
    return { valid: false, reason: "workloadClasses must not contain duplicates" };
  }
  for (const klass of s.workloadClasses) {
    if (typeof klass !== "string" || !isWorkloadClass(klass)) {
      return {
        valid: false,
        reason: `workload class "${String(klass)}" is not in the frozen vocabulary`,
      };
    }
  }
  if (!Array.isArray(s.modalities)) {
    return { valid: false, reason: "modalities must be an array" };
  }
  if (new Set(s.modalities).size !== s.modalities.length) {
    return { valid: false, reason: "modalities must not contain duplicates" };
  }
  for (const atom of s.modalities) {
    if (typeof atom !== "string" || !(SUBSTRATE_MODALITIES as readonly string[]).includes(atom)) {
      return { valid: false, reason: `modality "${String(atom)}" is not neutral` };
    }
  }
  if (
    typeof s.latencyClass !== "string" ||
    !(SUBSTRATE_LATENCY_CLASSES as readonly string[]).includes(s.latencyClass)
  ) {
    return {
      valid: false,
      reason: `latencyClass must be one of ${SUBSTRATE_LATENCY_CLASSES.join("|")}`,
    };
  }
  if (s.resource === null || typeof s.resource !== "object") {
    return { valid: false, reason: "resource profile is required" };
  }
  const resource = s.resource as unknown as Record<string, unknown>;
  for (const field of ["cpuMilliCores", "memoryMiB", "estimatedDurationMs"] as const) {
    const value = resource[field];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      (field === "estimatedDurationMs" && value > 86_400_000) ||
      (field === "cpuMilliCores" && value > 64_000) ||
      (field === "memoryMiB" && value > 262_144)
    ) {
      return {
        valid: false,
        reason: `resource.${field} must be an integer within its neutral bound`,
      };
    }
  }
  if (
    typeof resource.estimatedCostMicroUsd !== "string" ||
    !MICRO_USD_PATTERN.test(resource.estimatedCostMicroUsd)
  ) {
    return {
      valid: false,
      reason: "resource.estimatedCostMicroUsd must be an integer micro-USD string",
    };
  }
  if (
    typeof s.isolation !== "string" ||
    !(SUBSTRATE_ISOLATION_CLASSES as readonly string[]).includes(s.isolation)
  ) {
    return {
      valid: false,
      reason: `isolation must be one of ${SUBSTRATE_ISOLATION_CLASSES.join("|")}`,
    };
  }
  if (!Array.isArray(s.sideEffectClasses) || s.sideEffectClasses.length === 0) {
    return { valid: false, reason: "sideEffectClasses must declare at least one class" };
  }
  for (const effect of s.sideEffectClasses) {
    if (
      typeof effect !== "string" ||
      !(SUBSTRATE_SIDE_EFFECT_CLASSES as readonly string[]).includes(effect)
    ) {
      return {
        valid: false,
        reason: `side-effect class "${String(effect)}" is not in the vocabulary`,
      };
    }
  }
  if (new Set(s.sideEffectClasses).size !== s.sideEffectClasses.length) {
    return { valid: false, reason: "sideEffectClasses must not contain duplicates" };
  }
  if (s.executionCapability === null || typeof s.executionCapability !== "object") {
    return {
      valid: false,
      reason: "executionCapability is required (the substrate's runtime claim)",
    };
  }
  const capability = s.executionCapability as Record<string, unknown>;
  if (typeof capability.id !== "string" || !CAPABILITY_PATTERN.test(capability.id)) {
    return {
      valid: false,
      reason: "executionCapability.id must be a neutral capability identifier",
    };
  }
  if (
    capability.minVersion !== undefined &&
    (typeof capability.minVersion !== "string" || !VERSION_PATTERN.test(capability.minVersion))
  ) {
    return {
      valid: false,
      reason: "executionCapability.minVersion must be major.minor.patch numerics",
    };
  }
  if (typeof s.adapterRef !== "string" || !ADAPTER_REF_PATTERN.test(s.adapterRef)) {
    return { valid: false, reason: "adapterRef must be an opaque neutral adapter reference" };
  }
  if (
    s.description !== undefined &&
    s.description !== null &&
    (typeof s.description !== "string" || s.description.length > MAX_DESCRIPTION)
  ) {
    return { valid: false, reason: `description must be at most ${MAX_DESCRIPTION} characters` };
  }
  if (typeof s.description === "string" && substrateContainsRawSecretValue(s.description)) {
    return { valid: false, reason: "description looks like it embeds a raw secret value" };
  }
  return { valid: true };
}

/**
 * Deterministic canonical JSON of the substrate body (sorted keys,
 * sorted vocabularies) — the content-addressing base.
 */
export function canonicalSubstrateJson(input: ComputationalSubstrateInput): string {
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
    "capabilities.substrate",
    input.substrateId,
    input.version,
    [...input.workloadClasses].sort(),
    [...input.modalities].sort(),
    input.latencyClass,
    canonical(input.resource),
    input.isolation,
    [...input.sideEffectClasses].sort(),
    canonical(input.executionCapability),
    input.adapterRef,
    canonical(input.description ?? null),
  ]);
}

/**
 * The capability claim a substrate publishes into the EXISTING registry
 * (kind "runtime", deterministic attributes carrying the substrate's
 * metadata as neutral attribute values — the registry remains the ONE
 * capability authority; substrates never create a second one).
 */
export function substrateCapabilityClaim(input: ComputationalSubstrateInput): {
  readonly claim: {
    readonly id: string;
    readonly kind: "runtime";
    readonly version: string;
    readonly attributes: Readonly<Record<string, string>>;
  };
  readonly evidenceReference: string;
} {
  return {
    claim: {
      id: input.executionCapability.id,
      kind: "runtime",
      version: input.version,
      attributes: {
        substrateId: input.substrateId,
        latencyClass: input.latencyClass,
        isolation: input.isolation,
        adapterRef: input.adapterRef,
      },
    },
    evidenceReference: `substrates:${input.substrateId}@${input.version}`,
  };
}
