/**
 * Runner fleet domain model (sandbox module; WORK-019, ENV-003).
 *
 * A RUNNER is one execution SUBSTRATE instance of the `customer-runner`
 * compute-environment kind — the customer-controlled twin of the
 * process/container/microVM/VM substrates. Runners are an extension of the
 * ComputeEnvironment authority (`spec/architecture.md` §15, ADR-0004/0016):
 * they are NEVER a new execution system, NEVER a second authority and NEVER
 * a policy/capability/budget engine:
 *
 *   - EXECUTION IDENTITY STAYS CANONICAL: a runner assignment binds to the
 *     PARENT `SandboxExecution` row (already admitted through the full
 *     policy → capability → budget gate by the sandbox service) and to its
 *     parent canonical execution row through composite FKs. The runner
 *     fleet owns assignment bookkeeping ONLY — the execution lifecycle
 *     state machine stays in the executions module (no execution status
 *     vocabulary exists in this file; the assignment vocabulary is
 *     physically disjoint). A reconnect NEVER creates a second logical
 *     execution.
 *   - REGISTRATION IS NOT TRUST: a newly registered runner is `untrusted`
 *     and can serve NOTHING until an operator explicitly authorizes it
 *     (M16); authorization is revocable and revocation is terminal.
 *   - EXTERNAL IDENTITY IS NOT AUTHORIZATION: the runner's durable
 *     platform identity (runnerId) plus the hashed fingerprint of its
 *     registration token are identity artifacts; the registration token
 *     proves channel continuity at reconnect, never grants anything.
 *     The parent canonical execution row is anchored through the shared
 *     migration's composite FKs (the executions module's private tables
 *     are never referenced from this module's TypeScript surface).
 *   - CAPABILITIES ARE DESCRIPTIVE: a runner DECLARES capabilities
 *     (`cpu`, `memory`, `filesystem`, `network`, `gpu`, `microvm`, `vm`,
 *     `customer-runner`); what the fleet does with them is a REQUIREMENT
 *     MATCH — the actual authorization to execute still flows through the
 *     existing policy/capability authorities at sandbox admission.
 *   - HEALTH IS OBSERVED, NOT CLAIMED: heartbeat observations age; a
 *     runner whose heartbeat is stale (or unhealthy) is unassignable
 *     (M20) — dead runners never receive work.
 *   - ONE ACTIVE ASSIGNMENT PER RUNNER: no split-brain ownership (M19);
 *     leases are explicit (leasedAt/expiresAt) and expiry is terminal.
 *
 * Provider neutrality (M14): this vocabulary is substrate-neutral — no
 * VM vendor, hypervisor or cloud identifier exists anywhere in this file;
 * microVM/VM tiers are named by their isolation class only, and concrete
 * runtime mechanics live behind adapters (`ports/`, `adapters/`).
 *
 * Security model at this layer:
 *   - the handoff contract carries secret REFERENCES only (no value field
 *     exists; raw secret-shaped values are rejected at validation — M17);
 *   - host-shaped paths are unrepresentable in runner references
 *     (`refLooksLikeHostPath`, the environment contract's rule restated);
 *   - the task crossing to a runner is the sandbox task contract
 *     (argv + EXPLICIT non-secret publicEnv, `domain/sandbox.ts`).
 */

import type {
  SandboxEnvironmentKind,
  SandboxFilesystemPolicy,
  SandboxNetworkPolicy,
  SandboxResourceLimits,
} from "./environment";
import { refLooksLikeHostPath } from "./environment";
import type { SandboxFailureClass, SandboxOutcomeClass, SandboxTask } from "./sandbox";
import { containsRawSecretValue } from "./sandbox";

// ---------------------------------------------------------------------------
// Runner capabilities (descriptive; authorization stays with the authorities)
// ---------------------------------------------------------------------------

/**
 * The runner capability vocabulary (provider-neutral isolation/compute
 * classes). Declaration is DESCRIPTIVE: matching it satisfies a substrate
 * requirement, never an authorization.
 */
export const RUNNER_CAPABILITY_IDS = [
  "cpu",
  "memory",
  "filesystem",
  "network",
  "gpu",
  "microvm",
  "vm",
  "customer-runner",
] as const;

export type RunnerCapabilityId = (typeof RUNNER_CAPABILITY_IDS)[number];

export const MAX_RUNNER_CAPABILITIES = 16;

export function isRunnerCapabilityId(value: string): value is RunnerCapabilityId {
  return (RUNNER_CAPABILITY_IDS as readonly string[]).includes(value);
}

/** Validate a capability declaration list (vocabulary, dedup, bounds). */
export function validateRunnerCapabilities(capabilities: readonly string[]): RunnerFleetValidation {
  if (!Array.isArray(capabilities)) {
    return { valid: false, reason: "declared capabilities must be an array" };
  }
  if (capabilities.length === 0) {
    return { valid: false, reason: "a runner must declare at least one capability" };
  }
  if (capabilities.length > MAX_RUNNER_CAPABILITIES) {
    return { valid: false, reason: `at most ${MAX_RUNNER_CAPABILITIES} capabilities per runner` };
  }
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !isRunnerCapabilityId(capability)) {
      return {
        valid: false,
        reason: `"${String(capability)}" is not a known runner capability (${RUNNER_CAPABILITY_IDS.join("|")})`,
      };
    }
    if (seen.has(capability)) {
      return { valid: false, reason: `capability "${capability}" is declared twice` };
    }
    seen.add(capability);
  }
  return { valid: true };
}

/** Whether a runner's declared capabilities cover every requirement. */
export function runnerSupportsRequirements(
  declared: readonly string[],
  required: readonly string[],
): boolean {
  const set = new Set(declared);
  return required.every((capability) => set.has(capability));
}

// ---------------------------------------------------------------------------
// Runner authorization lifecycle (explicit trust, revocable, terminal)
// ---------------------------------------------------------------------------

/**
 * `untrusted` (registered — can serve NOTHING) → `authorized` (explicit
 * operator grant) → `revoked` (terminal: a revoked runner is never
 * re-authorized; a replacement is a NEW registration).
 */
export const RUNNER_AUTHORIZATION_STATUSES = ["untrusted", "authorized", "revoked"] as const;

export type RunnerAuthorizationStatus = (typeof RUNNER_AUTHORIZATION_STATUSES)[number];

export const RUNNER_AUTHORIZATION_TRANSITIONS: Readonly<
  Record<RunnerAuthorizationStatus, readonly RunnerAuthorizationStatus[]>
> = {
  untrusted: ["authorized", "revoked"],
  authorized: ["revoked"],
  revoked: [],
};

export function isRunnerAuthorizationStatus(value: string): value is RunnerAuthorizationStatus {
  return (RUNNER_AUTHORIZATION_STATUSES as readonly string[]).includes(value);
}

export function canTransitionRunnerAuthorization(
  from: RunnerAuthorizationStatus,
  to: RunnerAuthorizationStatus,
): boolean {
  return RUNNER_AUTHORIZATION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Runner health + connection observation
// ---------------------------------------------------------------------------

export const RUNNER_HEALTH_STATUSES = ["unknown", "healthy", "degraded", "unhealthy"] as const;

export type RunnerHealthStatus = (typeof RUNNER_HEALTH_STATUSES)[number];

export function isRunnerHealthStatus(value: string): value is RunnerHealthStatus {
  return (RUNNER_HEALTH_STATUSES as readonly string[]).includes(value);
}

/** Connection observations (a runner may drop and safely re-attach). */
export const RUNNER_CONNECTION_STATUSES = ["offline", "connected", "disconnected"] as const;

export type RunnerConnectionStatus = (typeof RUNNER_CONNECTION_STATUSES)[number];

export function isRunnerConnectionStatus(value: string): value is RunnerConnectionStatus {
  return (RUNNER_CONNECTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether a runner is health-eligible for a NEW assignment: explicitly
 * healthy AND with a heartbeat inside the freshness window (M20 — a dead
 * or silent runner is never assigned work).
 */
export function isRunnerHealthyForAssignment(
  runner: { readonly healthStatus: RunnerHealthStatus; readonly lastHeartbeatAt: string | null },
  nowMs: number,
  heartbeatWindowMs: number,
): boolean {
  if (runner.healthStatus !== "healthy") {
    return false;
  }
  if (runner.lastHeartbeatAt === null) {
    return false;
  }
  const heartbeatMs = Date.parse(runner.lastHeartbeatAt);
  if (Number.isNaN(heartbeatMs)) {
    return false;
  }
  return nowMs - heartbeatMs <= heartbeatWindowMs;
}

// ---------------------------------------------------------------------------
// Assignment lifecycle (explicit, deterministic, subordinate bookkeeping)
// ---------------------------------------------------------------------------

/**
 * The assignment journal states — SUBORDINATE to the sandbox/execution
 * lifecycle (never a second execution state machine; the vocabulary is
 * disjoint from every execution status):
 *
 *   assigned   — durable assignment + active lease (idempotent by key)
 *   dispatched — the handoff was delivered to the runner (one-shot claim)
 *   completed  — terminal: the runner reported a success outcome
 *   failed     — terminal: the runner reported a failure outcome
 *   released   — terminal: released before completion (operator/revocation)
 *   expired    — terminal: the lease expired without a report (fail-closed)
 */
export const RUNNER_ASSIGNMENT_STATUSES = [
  "assigned",
  "dispatched",
  "completed",
  "failed",
  "released",
  "expired",
] as const;

export type RunnerAssignmentStatus = (typeof RUNNER_ASSIGNMENT_STATUSES)[number];

export const TERMINAL_RUNNER_ASSIGNMENT_STATUSES = [
  "completed",
  "failed",
  "released",
  "expired",
] as const;

export function isRunnerAssignmentStatus(value: string): value is RunnerAssignmentStatus {
  return (RUNNER_ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalRunnerAssignmentStatus(status: RunnerAssignmentStatus): boolean {
  return (TERMINAL_RUNNER_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

/** The legal assignment transitions (guarded physically in PostgreSQL). */
export const RUNNER_ASSIGNMENT_TRANSITIONS: Readonly<
  Record<RunnerAssignmentStatus, readonly RunnerAssignmentStatus[]>
> = {
  assigned: ["dispatched", "released", "expired"],
  dispatched: ["completed", "failed", "released", "expired"],
  completed: [],
  failed: [],
  released: [],
  expired: [],
};

export function canTransitionRunnerAssignment(
  from: RunnerAssignmentStatus,
  to: RunnerAssignmentStatus,
): boolean {
  return RUNNER_ASSIGNMENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Provenance (durable, revision-bound; M18)
// ---------------------------------------------------------------------------

/** Registration provenance — who registered what, through which channel. */
export interface RunnerProvenance {
  readonly actorId: string;
  readonly cause: string;
  /** The neutral channel the registration arrived through (e.g. "runners-gateway"). */
  readonly channel: string;
  readonly registeredAt: string;
}

/**
 * Assignment provenance — the full identity chain a remote handoff must
 * preserve: execution, sandbox, environment, runner identity/version, the
 * parent sandbox's ledger admission sequence (step-event identity), the
 * acting cause, the capability requirements and the reconnect history.
 * Write-once on the assignment row (physically immutable core fields).
 */
export interface RunnerAssignmentProvenance {
  readonly executionId: string;
  readonly sandboxId: string;
  readonly environmentId: string;
  readonly sandboxLedgerAdmittedSequence: number | null;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly actorId: string;
  readonly cause: string;
  readonly assignedAt: string;
  readonly requiredCapabilities: readonly string[];
}

// ---------------------------------------------------------------------------
// The runner record
// ---------------------------------------------------------------------------

export interface RunnerRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The compute environment (kind `customer-runner`) this runner serves. */
  readonly environmentId: string;
  readonly slug: string;
  readonly name: string;
  readonly runnerVersion: string;
  /** Descriptive capability declaration (vocabulary-checked). */
  readonly declaredCapabilities: readonly string[];
  /** SHA-256 fingerprint of the presented registration token (never the token). */
  readonly tokenFingerprint: string;
  readonly provenance: RunnerProvenance;
  readonly authorizationStatus: RunnerAuthorizationStatus;
  readonly authorizedAt: string | null;
  readonly authorizedByActorId: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly healthStatus: RunnerHealthStatus;
  readonly lastHeartbeatAt: string | null;
  readonly connectionStatus: RunnerConnectionStatus;
  readonly lastConnectedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunnerRegistrationInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly slug: string;
  readonly name: string;
  readonly runnerVersion: string;
  readonly declaredCapabilities: readonly string[];
  /** The runner's presented registration token (hashed before storage). */
  readonly registrationToken: string;
  readonly provenance: RunnerProvenance;
}

// ---------------------------------------------------------------------------
// The assignment record
// ---------------------------------------------------------------------------

export interface RunnerAssignmentLease {
  readonly leasedAt: string;
  readonly leaseExpiresAt: string;
  readonly leaseDurationMs: number;
}

export interface RunnerAssignmentRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The canonical execution identity (preserved across the whole handoff). */
  readonly executionId: string;
  /** The admitted sandbox execution this assignment executes. */
  readonly sandboxId: string;
  readonly environmentId: string;
  readonly runnerId: string;
  /** The idempotency anchor: one durable row per (application, key). */
  readonly assignmentKey: string;
  readonly requestFingerprint: string;
  readonly status: RunnerAssignmentStatus;
  readonly requiredCapabilities: readonly string[];
  readonly lease: RunnerAssignmentLease;
  readonly dispatchedAt: string | null;
  /** One-time handoff nonce (replay of a delivered handoff carries the same nonce). */
  readonly handoffNonce: string | null;
  readonly reportedAt: string | null;
  readonly outcomeClass: SandboxOutcomeClass | null;
  readonly failureClass: SandboxFailureClass | null;
  readonly outputDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly provenance: RunnerAssignmentProvenance;
  readonly reconnectCount: number;
  /** Terminal release facts (status `released` only). */
  readonly releasedReason: string | null;
  readonly releasedAt: string | null;
  /** Terminal expiry fact (status `expired` only). */
  readonly expiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The remote execution handoff (the neutral remote-execution contract)
// ---------------------------------------------------------------------------

/**
 * The sanitized remote-execution handoff delivered to a runner through the
 * `RunnerChannel` port. Identity-preserving by construction: it carries the
 * SAME execution/sandbox identities the admission decided, the task from
 * the immutable admitted snapshot, REFERENCES only (never secret values,
 * never host paths — M17) and the lease window that bounds the remote work.
 */
export interface RunnerHandoff {
  readonly assignmentId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sandboxId: string;
  readonly environmentId: string;
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly kind: SandboxEnvironmentKind;
  readonly task: SandboxTask;
  readonly limits: SandboxResourceLimits | null;
  readonly network: SandboxNetworkPolicy;
  readonly filesystem: SandboxFilesystemPolicy;
  /** Mediated secret references (opaque — never values). */
  readonly secretRefs: readonly string[];
  readonly leaseExpiresAt: string;
  readonly handoffNonce: string;
  readonly reconnectCount: number;
  readonly provenance: RunnerAssignmentProvenance;
}

/**
 * A runner's result report — the sandbox-axis observation of the remote
 * execution (the provider maps it onto `SandboxExecutionObservation`; the
 * runner can NEVER express verification/provider/tool outcomes).
 */
export interface RunnerResultReport {
  readonly outcomeClass: SandboxOutcomeClass;
  readonly outputDigest: string | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly usageMicroUsd: string | null;
  readonly failure: {
    readonly failureClass: SandboxFailureClass;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RunnerFleetValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

const RUNNER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUNNER_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** Registration tokens: printable, bounded, non-empty (hashed before storage). */
export const RUNNER_TOKEN_PATTERN = /^[\x21-\x7e]{16,256}$/;
/** Assignment keys: printable opaque strings (the idempotency anchor). */
export const RUNNER_ASSIGNMENT_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
export const RUNNER_PROVENANCE_CAUSE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RUNNER_PROVENANCE_CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MICRO_USD_PATTERN = /^\d{1,16}$/;

/**
 * Validate runner registration input. Raw secret-shaped tokens and
 * host-shaped identifiers are rejected BEFORE anything durable (M16/M17).
 */
export function validateRunnerRegistration(input: RunnerRegistrationInput): RunnerFleetValidation {
  if (!RUNNER_SLUG_PATTERN.test(input?.slug ?? "")) {
    return { valid: false, reason: "runner slug must be lowercase alphanumeric/hyphen (max 64)" };
  }
  if (typeof input?.name !== "string" || input.name.length < 1 || input.name.length > 200) {
    return { valid: false, reason: "runner name must be 1..200 characters" };
  }
  if (!RUNNER_VERSION_PATTERN.test(input?.runnerVersion ?? "")) {
    return { valid: false, reason: "runner version must be major.minor.patch numerics" };
  }
  const capabilityCheck = validateRunnerCapabilities(input?.declaredCapabilities ?? []);
  if (!capabilityCheck.valid) {
    return capabilityCheck;
  }
  if (!RUNNER_TOKEN_PATTERN.test(input?.registrationToken ?? "")) {
    return {
      valid: false,
      reason:
        "registration token must be 16..256 printable characters (stored hashed, never returned)",
    };
  }
  if (containsRawSecretValue(input?.registrationToken ?? "")) {
    return {
      valid: false,
      reason:
        "registration token looks like a raw platform/provider secret; runner registration tokens are opaque opaque-channel artifacts, never reused provider credentials",
    };
  }
  const provenance = input?.provenance;
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    !RUNNER_PROVENANCE_CAUSE_PATTERN.test(provenance.cause ?? "") ||
    !RUNNER_PROVENANCE_CHANNEL_PATTERN.test(provenance.channel ?? "") ||
    typeof provenance.actorId !== "string" ||
    provenance.actorId.length === 0 ||
    Number.isNaN(Date.parse(provenance.registeredAt ?? ""))
  ) {
    return { valid: false, reason: "runner registration provenance is malformed" };
  }
  return { valid: true };
}

/** Validate a lease shape (positive, ordered, bounded). */
export function validateRunnerLease(lease: {
  readonly leasedAt: string;
  readonly leaseExpiresAt: string;
  readonly leaseDurationMs: number;
}): RunnerFleetValidation {
  const leasedMs = Date.parse(lease.leasedAt);
  const expiresMs = Date.parse(lease.leaseExpiresAt);
  if (Number.isNaN(leasedMs) || Number.isNaN(expiresMs)) {
    return { valid: false, reason: "lease timestamps must be RFC3339" };
  }
  if (
    !Number.isInteger(lease.leaseDurationMs) ||
    lease.leaseDurationMs <= 0 ||
    lease.leaseDurationMs > 86_400_000
  ) {
    return { valid: false, reason: "lease duration must be 1..86_400_000 ms" };
  }
  if (expiresMs - leasedMs !== lease.leaseDurationMs) {
    return { valid: false, reason: "lease expiry must equal leasedAt + duration" };
  }
  return { valid: true };
}

/**
 * Validate a runner result report (the runner axis only: no verification,
 * provider or tool vocabulary is representable — M9/M15).
 */
export function validateRunnerResultReport(report: RunnerResultReport): RunnerFleetValidation {
  if (report === null || typeof report !== "object") {
    return { valid: false, reason: "result report must be an object" };
  }
  if (report.outcomeClass !== "sandbox-success" && report.outcomeClass !== "sandbox-failure") {
    return {
      valid: false,
      reason: 'report outcomeClass must be "sandbox-success" or "sandbox-failure"',
    };
  }
  if (report.outcomeClass === "sandbox-success" && report.failure !== null) {
    return { valid: false, reason: "a success report cannot carry a failure" };
  }
  if (report.outcomeClass === "sandbox-failure" && report.failure === null) {
    return { valid: false, reason: "a failure report must carry a failure" };
  }
  if (report.usageMicroUsd !== null && !MICRO_USD_PATTERN.test(report.usageMicroUsd)) {
    return { valid: false, reason: "usage must be a non-negative integer micro-USD string" };
  }
  return { valid: true };
}

/** Validate that a neutral runner reference is opaque (never a host path). */
export function validateRunnerReference(reference: string): RunnerFleetValidation {
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 200) {
    return { valid: false, reason: "runner references must be 1..200 characters" };
  }
  if (refLooksLikeHostPath(reference)) {
    return {
      valid: false,
      reason: `"${reference}" looks like a host path; runner references are opaque identifiers, never host locations`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// The assignment request fingerprint (the idempotency discriminator)
// ---------------------------------------------------------------------------

export interface RunnerAssignmentRequest {
  readonly executionId: string;
  readonly sandboxId: string;
  readonly environmentId: string;
  readonly requiredCapabilities: readonly string[];
}

/**
 * Canonical request fingerprint (deterministic JSON, sorted keys): the SAME
 * logical assignment request replays the SAME durable outcome; the runner
 * CHOICE is deliberately excluded — it is substrate selection, not request
 * identity. A different fingerprint under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export function runnerAssignmentFingerprint(
  applicationId: string,
  request: RunnerAssignmentRequest,
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
    "runner.assign",
    applicationId,
    request.executionId,
    request.sandboxId,
    request.environmentId,
    canonical([...request.requiredCapabilities].sort()),
  ]);
}

/**
 * Canonical registration fingerprint (content addressing for the runner
 * identity core — a different declaration under the same slug is an
 * identity conflict, never a silent overwrite). The token enters as its
 * one-way FINGERPRINT (the service hashes before anything durable).
 */
export function runnerRegistrationFingerprint(
  input: Omit<RunnerRegistrationInput, "registrationToken">,
  tokenFingerprint: string,
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
    "runner.register",
    input.environmentId,
    input.runnerVersion,
    canonical([...input.declaredCapabilities].sort()),
    tokenFingerprint,
  ]);
}
