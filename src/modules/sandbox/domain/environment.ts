/**
 * Compute-environment domain model (sandbox module; WORK-012, ENV-001).
 *
 * The provider-neutral `ComputeEnvironment` contract family
 * (`spec/architecture.md` §15, `IMPLEMENTATION.md` §11): an execution
 * environment is a DECLARED, version-immutable specification of where
 * governed work runs — never a provider type. Docker/Kubernetes/OCI/SDK
 * vocabularies are structurally absent from this file (discrimination M14);
 * provider mechanics live behind adapters and `src/platform/sandbox/`.
 *
 * Design invariants (the Work Order's security model):
 *
 *   - DEFAULT DENY: a sandbox never inherits ambient host access. There is
 *     NO field that can express host filesystem mounts, host network, host
 *     process/device access or ambient environment inheritance — the
 *     dangerous states are unrepresentable in the contract, and the
 *     platform-layer configuration validator additionally rejects
 *     escape-shaped runtime configurations at dispatch.
 *   - NO-EXECUTION IS FIRST CLASS: `no-execution` is a legitimate
 *     environment kind (a plan may require no compute runtime at all); it
 *     carries no limits and no runtime requirement, and its dispatch is a
 *     structural no-op that never touches a provider (M17).
 *   - RESOURCE LIMITS ARE EXPLICIT: process/container environments MUST
 *     declare cpu/memory/time bounds — missing limits are a validation
 *     failure, never a silent unlimited host default (M4/M18).
 *   - NETWORK IS EXPLICIT: egress is `none` or an explicit `allowlist`
 *     (`open` is unrepresentable in the sandbox contract — the sandbox may
 *     only ever be tighter than the effective policy's network dimension).
 *   - SECRETS ARE REFERENCES: the contract carries opaque secret
 *     REFERENCES only; raw secret values are rejected at validation
 *     (`containsRawSecretValue`, M8) and no value field exists anywhere.
 */

// ---------------------------------------------------------------------------
// Environment kinds (ENV-001; aligned with the policies isolation ladder)
// ---------------------------------------------------------------------------

/**
 * The compute-environment kind vocabulary — provider-neutral, aligned 1:1
 * with the policies module's frozen isolation ladder (`ISOLATION_LEVELS`)
 * with `no-execution` the sandbox-side name of ladder level `none`.
 * `process`/`container` are the v1 implemented kinds; `microvm`/`vm`/
 * `customer-runner` are the ADR-0004/0016 evolution kinds — registrable as
 * specifications (the vocabulary is the ladder) but without shipped
 * providers, so dispatch fails closed until the owning Work Orders
 * (WORK-019+) wire runtime adapters.
 */
export const SANDBOX_ENVIRONMENT_KINDS = [
  "no-execution",
  "process",
  "container",
  "microvm",
  "vm",
  "customer-runner",
] as const;

export type SandboxEnvironmentKind = (typeof SANDBOX_ENVIRONMENT_KINDS)[number];

/** The environment kinds with a shipped provider adapter in this Work Order. */
export const IMPLEMENTED_SANDBOX_KINDS = ["no-execution", "process", "container"] as const;

export function isSandboxEnvironmentKind(value: string): value is SandboxEnvironmentKind {
  return (SANDBOX_ENVIRONMENT_KINDS as readonly string[]).includes(value);
}

/** Kinds that actually execute work (everything except no-execution). */
export function kindExecutes(kind: SandboxEnvironmentKind): boolean {
  return kind !== "no-execution";
}

// ---------------------------------------------------------------------------
// Environment lifecycle (small, explicit, subordinate to Execution)
// ---------------------------------------------------------------------------

export const ENVIRONMENT_LIFECYCLE_STATUSES = ["available", "suspended", "retired"] as const;

export type EnvironmentLifecycleStatus = (typeof ENVIRONMENT_LIFECYCLE_STATUSES)[number];

export function isEnvironmentLifecycleStatus(value: string): value is EnvironmentLifecycleStatus {
  return (ENVIRONMENT_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

/** The explicit environment lifecycle transition table. */
export const ENVIRONMENT_TRANSITIONS: Readonly<
  Record<EnvironmentLifecycleStatus, readonly EnvironmentLifecycleStatus[]>
> = {
  available: ["suspended", "retired"],
  suspended: ["available", "retired"],
  retired: [],
};

export function canTransitionEnvironment(
  from: EnvironmentLifecycleStatus,
  to: EnvironmentLifecycleStatus,
): boolean {
  return ENVIRONMENT_TRANSITIONS[from].includes(to);
}

export function isTerminalEnvironmentStatus(status: EnvironmentLifecycleStatus): boolean {
  return status === "retired";
}

// ---------------------------------------------------------------------------
// Resource limits (explicit; no unlimited host defaults — M4/M18)
// ---------------------------------------------------------------------------

/**
 * Bounded resource constraints. `cpuMilliCores`, `memoryMiB` and
 * `executionTimeoutMs` are MANDATORY for executing kinds (a missing bound
 * fails validation — resource values never fall back to host defaults);
 * storage/process/network-byte bounds are optional but, when present,
 * positive and bounded.
 */
export interface SandboxResourceLimits {
  /** CPU ceiling in milli-cores (1000 = one full core). Required. */
  readonly cpuMilliCores: number;
  /** Memory ceiling in MiB. Required. */
  readonly memoryMiB: number;
  /** Hard wall-clock bound on one dispatch, in milliseconds. Required. */
  readonly executionTimeoutMs: number;
  /** Ephemeral storage bound in MiB. Optional. */
  readonly storageMiB?: number;
  /** Concurrent process-count bound inside the environment. Optional. */
  readonly processCount?: number;
  /** Total outbound network byte bound. Optional. */
  readonly networkEgressBytes?: number;
}

export const RESOURCE_LIMIT_BOUNDS = {
  cpuMilliCores: { min: 1, max: 64_000 },
  memoryMiB: { min: 4, max: 262_144 },
  executionTimeoutMs: { min: 1, max: 86_400_000 },
  storageMiB: { min: 1, max: 1_048_576 },
  processCount: { min: 1, max: 512 },
  networkEgressBytes: { min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;

// ---------------------------------------------------------------------------
// Network policy (explicit; "open" is unrepresentable)
// ---------------------------------------------------------------------------

/** Sandbox egress modes — deliberately narrower than the policy ladder. */
export const SANDBOX_EGRESS_MODES = ["none", "allowlist"] as const;

export type SandboxEgressMode = (typeof SANDBOX_EGRESS_MODES)[number];

export interface SandboxNetworkPolicy {
  /** `none` (default-deny) or an explicit host allowlist. Never `open`. */
  readonly egress: SandboxEgressMode;
  /** Required non-empty iff egress is `allowlist`; empty otherwise. */
  readonly allowedHosts: readonly string[];
}

// ---------------------------------------------------------------------------
// Filesystem policy (explicit; host paths are unrepresentable)
// ---------------------------------------------------------------------------

/**
 * Workspace modes. There is no host-filesystem mode and no host-mount
 * field anywhere in the contract: a sandbox gets an isolated ephemeral
 * workspace or nothing.
 */
export const SANDBOX_WORKSPACE_MODES = [
  "none",
  "ephemeral-read-only",
  "ephemeral-writable",
] as const;

export type SandboxWorkspaceMode = (typeof SANDBOX_WORKSPACE_MODES)[number];

export interface SandboxFilesystemPolicy {
  /** The sandbox's private ephemeral workspace (never the host filesystem). */
  readonly workspace: SandboxWorkspaceMode;
  /**
   * Explicit input mounts: opaque ARTIFACT REFERENCES (resolved by the
   * platform object store), mounted read-only. Host-shaped paths are
   * rejected at validation (M5).
   */
  readonly readOnlyArtifactRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Secret policy (references only — M8)
// ---------------------------------------------------------------------------

export interface SandboxSecretPolicy {
  /** Opaque secret references mediated by the connections vault. */
  readonly secretRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Runtime requirement + cost expectation
// ---------------------------------------------------------------------------

/** The runtime capability the environment requires (capability admission). */
export interface SandboxRuntimeRequirement {
  /** Provider-neutral runtime capability identifier (e.g. "process-sandbox"). */
  readonly capabilityId: string;
  readonly minVersion?: string;
}

/** Cost expectation of one dispatch (integer micro-USD; "0" = uncosted). */
export interface SandboxCostExpectation {
  readonly estimatedCostMicroUsd: string;
}

// ---------------------------------------------------------------------------
// The provider-neutral environment specification
// ---------------------------------------------------------------------------

export interface ComputeEnvironmentSpec {
  readonly kind: SandboxEnvironmentKind;
  /**
   * Mandatory (non-null) for executing kinds; MUST be null for
   * `no-execution` (nothing runs — there is nothing to bound).
   */
  readonly limits: SandboxResourceLimits | null;
  readonly network: SandboxNetworkPolicy;
  readonly filesystem: SandboxFilesystemPolicy;
  readonly secrets: SandboxSecretPolicy;
  /**
   * The runtime capability requirement; null for `no-execution`,
   * mandatory for executing kinds (capability-before-provider).
   */
  readonly runtime: SandboxRuntimeRequirement | null;
  readonly cost: SandboxCostExpectation;
}

/** The durable catalog record of one compute environment. */
export interface ComputeEnvironmentRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: SandboxEnvironmentKind;
  readonly spec: ComputeEnvironmentSpec;
  readonly specDigest: string;
  readonly status: EnvironmentLifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ComputeEnvironmentRegistrationInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly spec: ComputeEnvironmentSpec;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SpecValidationIssue {
  readonly field: string;
  readonly reason: string;
}

export interface SpecValidation {
  readonly valid: boolean;
  readonly issues: readonly SpecValidationIssue[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const RUNTIME_CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MICRO_USD_PATTERN = /^\d{1,16}$/;

/** An opaque bounded reference (artifact refs, secret refs). */
export const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
export const MAX_REFS = 32;

/**
 * Host-shaped path detection for reference fields: absolute paths, parent
 * traversal, home-relative paths, Windows drive letters and path
 * separators that could denote a host location are rejected (M5). A
 * reference is an OPAQUE identifier, never a filesystem location.
 */
export function refLooksLikeHostPath(ref: string): boolean {
  if (
    ref.startsWith("/") ||
    ref.startsWith("~") ||
    ref.startsWith("\\") ||
    /^[A-Za-z]:/.test(ref)
  ) {
    return true;
  }
  if (ref.includes("..") || ref.includes("\\") || ref.includes("\0")) {
    return true;
  }
  // Host pseudo-filesystem roots by name (relative "proc"/"sys"-style
  // references are still host namespaces — mirrors the platform mount
  // validator so both layers reject the same shapes).
  if (
    /^(proc|sys|dev|etc|var|usr|bin|sbin|lib|boot|root|home|mnt|media|opt|srv|run|tmp)(\/|$)/.test(
      ref,
    )
  ) {
    return true;
  }
  return false;
}

function validateRefList(
  refs: readonly string[],
  field: string,
  issues: SpecValidationIssue[],
): void {
  if (refs.length > MAX_REFS) {
    issues.push({ field, reason: `at most ${MAX_REFS} references are allowed` });
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
        reason: `"${ref}" looks like a host path; references are opaque identifiers, never host locations`,
      });
    }
  }
}

function validateLimits(
  limits: SandboxResourceLimits | null,
  executing: boolean,
  issues: SpecValidationIssue[],
): void {
  if (!executing) {
    if (limits !== null) {
      issues.push({
        field: "limits",
        reason: "a no-execution environment must not declare resource limits (nothing runs)",
      });
    }
    return;
  }
  if (limits === null) {
    issues.push({
      field: "limits",
      reason:
        "executing environments MUST declare explicit resource limits (missing bounds never fall back to unlimited host defaults)",
    });
    return;
  }
  const bounds: ReadonlyArray<
    readonly [keyof SandboxResourceLimits, { readonly min: number; readonly max: number }, boolean]
  > = [
    ["cpuMilliCores", RESOURCE_LIMIT_BOUNDS.cpuMilliCores, true],
    ["memoryMiB", RESOURCE_LIMIT_BOUNDS.memoryMiB, true],
    ["executionTimeoutMs", RESOURCE_LIMIT_BOUNDS.executionTimeoutMs, true],
    ["storageMiB", RESOURCE_LIMIT_BOUNDS.storageMiB, false],
    ["processCount", RESOURCE_LIMIT_BOUNDS.processCount, false],
    ["networkEgressBytes", RESOURCE_LIMIT_BOUNDS.networkEgressBytes, false],
  ];
  for (const [field, bound, required] of bounds) {
    const value = limits[field];
    if (value === undefined) {
      if (required) {
        issues.push({
          field: `limits.${field}`,
          reason: "required limit is missing (resource values must be explicit, never defaulted)",
        });
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      issues.push({ field: `limits.${field}`, reason: "must be an integer" });
      continue;
    }
    if (value < bound.min || value > bound.max) {
      issues.push({
        field: `limits.${field}`,
        reason: `must be between ${bound.min} and ${bound.max}`,
      });
    }
  }
}

function validateNetwork(
  network: SandboxNetworkPolicy,
  executing: boolean,
  issues: SpecValidationIssue[],
): void {
  if (network === null || typeof network !== "object") {
    issues.push({ field: "network", reason: "network policy is required" });
    return;
  }
  if (!(SANDBOX_EGRESS_MODES as readonly string[]).includes(network.egress)) {
    issues.push({
      field: "network.egress",
      reason: `egress must be one of ${SANDBOX_EGRESS_MODES.join("|")} ("open" is not representable for a sandbox)`,
    });
    return;
  }
  const hosts = network.allowedHosts ?? [];
  if (!Array.isArray(hosts)) {
    issues.push({ field: "network.allowedHosts", reason: "allowedHosts must be an array" });
    return;
  }
  if (network.egress === "none" && hosts.length > 0) {
    issues.push({
      field: "network.allowedHosts",
      reason: "must be empty when egress is none",
    });
  }
  if (network.egress === "allowlist" && hosts.length === 0) {
    issues.push({
      field: "network.allowedHosts",
      reason: "an allowlist egress requires at least one host",
    });
  }
  if (hosts.length > 128) {
    issues.push({ field: "network.allowedHosts", reason: "at most 128 hosts are allowed" });
  }
  for (const host of hosts) {
    if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
      issues.push({
        field: "network.allowedHosts",
        reason: `"${String(host)}" is not a valid host`,
      });
    }
  }
  if (!executing && network.egress !== "none") {
    issues.push({
      field: "network.egress",
      reason: "a no-execution environment must not declare network egress",
    });
  }
}

function validateFilesystem(
  filesystem: SandboxFilesystemPolicy,
  executing: boolean,
  issues: SpecValidationIssue[],
): void {
  if (filesystem === null || typeof filesystem !== "object") {
    issues.push({ field: "filesystem", reason: "filesystem policy is required" });
    return;
  }
  if (!(SANDBOX_WORKSPACE_MODES as readonly string[]).includes(filesystem.workspace)) {
    issues.push({
      field: "filesystem.workspace",
      reason: `workspace must be one of ${SANDBOX_WORKSPACE_MODES.join("|")}`,
    });
  }
  if (!executing && filesystem.workspace !== "none") {
    issues.push({
      field: "filesystem.workspace",
      reason: "a no-execution environment must not declare a workspace",
    });
  }
  validateRefList(filesystem.readOnlyArtifactRefs ?? [], "filesystem.readOnlyArtifactRefs", issues);
}

function validateSecrets(
  secrets: SandboxSecretPolicy,
  executing: boolean,
  issues: SpecValidationIssue[],
): void {
  if (secrets === null || typeof secrets !== "object") {
    issues.push({ field: "secrets", reason: "secret policy is required" });
    return;
  }
  validateRefList(secrets.secretRefs ?? [], "secrets.secretRefs", issues);
  if (!executing && secrets.secretRefs.length > 0) {
    issues.push({
      field: "secrets.secretRefs",
      reason: "a no-execution environment must not declare secret references",
    });
  }
}

/**
 * Validate a complete provider-neutral environment specification. Pure and
 * total: every issue is typed and field-qualified; no I/O.
 */
export function validateComputeEnvironmentSpec(spec: ComputeEnvironmentSpec): SpecValidation {
  const issues: SpecValidationIssue[] = [];
  if (spec === null || typeof spec !== "object") {
    return { valid: false, issues: [{ field: "spec", reason: "spec must be an object" }] };
  }
  if (!isSandboxEnvironmentKind(spec.kind)) {
    issues.push({
      field: "kind",
      reason: `kind must be one of ${SANDBOX_ENVIRONMENT_KINDS.join("|")}`,
    });
    return { valid: false, issues };
  }
  const executing = kindExecutes(spec.kind);
  validateLimits(spec.limits, executing, issues);
  validateNetwork(spec.network, executing, issues);
  validateFilesystem(spec.filesystem, executing, issues);
  validateSecrets(spec.secrets, executing, issues);

  if (!executing) {
    if (spec.runtime !== null) {
      issues.push({
        field: "runtime",
        reason: "a no-execution environment must not declare a runtime requirement",
      });
    }
  } else if (spec.runtime === null) {
    issues.push({
      field: "runtime",
      reason: "executing environments MUST declare a runtime capability requirement",
    });
  } else if (!RUNTIME_CAPABILITY_PATTERN.test(spec.runtime.capabilityId ?? "")) {
    issues.push({
      field: "runtime.capabilityId",
      reason: "must be a provider-neutral runtime capability identifier",
    });
  } else if (
    spec.runtime.minVersion !== undefined &&
    !SEMVER_PATTERN.test(spec.runtime.minVersion)
  ) {
    issues.push({ field: "runtime.minVersion", reason: "must be major.minor.patch numerics" });
  }

  if (spec.cost === null || typeof spec.cost !== "object") {
    issues.push({ field: "cost", reason: "cost expectation is required" });
  } else if (!MICRO_USD_PATTERN.test(spec.cost.estimatedCostMicroUsd ?? "")) {
    issues.push({
      field: "cost.estimatedCostMicroUsd",
      reason: "must be a non-negative integer micro-USD string",
    });
  }
  return { valid: issues.length === 0, issues };
}

/** Validate registration input (identity fields + spec). */
export function validateEnvironmentRegistration(
  input: ComputeEnvironmentRegistrationInput,
): SpecValidation {
  const issues: SpecValidationIssue[] = [];
  if (!SLUG_PATTERN.test(input.slug ?? "")) {
    issues.push({ field: "slug", reason: "must be lowercase alphanumeric/hyphen (max 64 chars)" });
  }
  if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 200) {
    issues.push({ field: "name", reason: "must be 1..200 characters" });
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 2000)
  ) {
    issues.push({ field: "description", reason: "must be at most 2000 characters" });
  }
  const specCheck = validateComputeEnvironmentSpec(input.spec);
  return {
    valid: issues.length === 0 && specCheck.valid,
    issues: [...issues, ...specCheck.issues],
  };
}

/**
 * Deterministic canonical JSON of a specification (sorted keys; the digest
 * base — content-addressed environment identity).
 */
export function canonicalEnvironmentJson(spec: ComputeEnvironmentSpec): string {
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
  return JSON.stringify(canonical(spec));
}
