/**
 * Execution-worker fabric port (platform compute plane; WORK-046, D-05).
 *
 * THE provider-neutral contract family of the execution-plane worker
 * fabric (`docs/DEPLOYMENT-ARCHITECTURE.md` execution plane,
 * `spec/work-orders/WORK-046.md`). A worker is an EXECUTOR, never an
 * execution authority: durable execution identity, lifecycle and
 * authoritative effects stay in Zeck PostgreSQL behind the existing
 * single execution write path. This port is the only seam the worker
 * fabric offers — every domain interaction crosses one of the four
 * seams the owning modules implement:
 *
 *   - `ExecutionDispatchStartEffect` — the governed re-entry of one
 *     dispatch into the execution lifecycle (implemented by the
 *     executions module over its frozen transition service);
 *   - `WorkerLeaseAuthority` — durable lease acquisition, renewal,
 *     release and the stale-worker fence check (implemented by the
 *     executions module over its long-running lease domain);
 *   - `ExecutionWorkExecutor` — resolution and execution of the
 *     admitted work of one execution through the owning module's
 *     authorities (implemented by the sandbox module over its public
 *     service and provider registry);
 *   - `WorkerCompletionEffect` — the lease-guarded commit of the
 *     observed work outcome back into the durable execution path
 *     (implemented by the executions module over its frozen
 *     transition + verification discipline).
 *
 * VOCABULARY DISCIPLINE (the D-03/D-04 lesson): every state/cause
 * vocabulary in this file is DISJOINT from the 14 frozen execution
 * states — there is no second execution state machine anywhere in
 * the worker plane. Worker-plane state is coordination, attribution
 * and recovery bookkeeping only: queue deliveries, worker-local
 * clocks, container state and provider runtime status are EVIDENCE
 * until the existing execution authority records the outcome.
 *
 *   - worker registration statuses: `active` / `draining` / `offline`;
 *   - claim states: `claimed` / `finished` / `abandoned`;
 *   - claim outcomes: `applied-success` / `applied-failure` /
 *     `converged-elsewhere` / `not-executable`;
 *   - abandon causes: bounded, auditable, never silent.
 *
 * The fabric stores REFERENCE-ONLY payloads (ids, keys, digests);
 * large artifacts stay in the artifact store, secret values never
 * enter worker-plane state.
 */

import type { DatabasePort } from "../db/port";
import type { DispatchEnvelope, QueueRetryPolicy, QueueTransportPort } from "../queue/port";

// ---------------------------------------------------------------------------
// Worker registration (the executor-instance registry)
// ---------------------------------------------------------------------------

/** The executor-instance classes of the worker fabric. */
export const WORKER_REGISTRATION_KINDS = ["first-party", "customer-runner"] as const;

export type WorkerRegistrationKind = (typeof WORKER_REGISTRATION_KINDS)[number];

/**
 * The worker registration lifecycle. `offline` is terminal — a worker
 * identity is never resurrected; a restarted process registers a NEW
 * identity (its predecessor's claims are recovered through lease
 * expiry and re-selection, never through identity reuse).
 */
export const WORKER_REGISTRATION_STATUSES = ["active", "draining", "offline"] as const;

export type WorkerRegistrationStatus = (typeof WORKER_REGISTRATION_STATUSES)[number];

export const WORKER_REGISTRATION_TRANSITIONS: Readonly<
  Record<WorkerRegistrationStatus, readonly WorkerRegistrationStatus[]>
> = {
  active: ["draining", "offline"],
  draining: ["offline"],
  offline: [],
};

/** One registered worker instance (durable, heartbeat-bearing). */
export interface WorkerRegistrationRecord {
  /** The worker identity (a UUID string; the lease owner is derived from it). */
  readonly workerId: string;
  /** The application the worker executes for (customer-runner workers are application-scoped). */
  readonly applicationId: string;
  readonly kind: WorkerRegistrationKind;
  /** The governed runner row this worker binds to (customer-runner kind only). */
  readonly runnerId: string | null;
  readonly status: WorkerRegistrationStatus;
  /**
   * The worker's declared concurrent-work bound. Enforced durably at
   * claim time (live claims per worker) AND in-process by the fabric
   * loop — both bounded, both observable.
   */
  readonly declaredConcurrency: number;
  readonly registeredAt: string;
  readonly lastHeartbeatAt: string;
  /** Monotonic heartbeat ledger (never regresses — DB-trigger guarded). */
  readonly heartbeatCount: number;
  readonly drainRequestedAt: string | null;
  readonly wentOfflineAt: string | null;
  /** Bounded, auditable offline cause. */
  readonly offlineReason: string | null;
  /** Bounded reference-only registration metadata (version, runtime id). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface WorkerRegistrationInput {
  readonly workerId: string;
  readonly applicationId: string;
  readonly kind: WorkerRegistrationKind;
  /** The governed runner binding (required when kind is customer-runner). */
  readonly runnerId?: string;
  readonly declaredConcurrency: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Customer-runner registration (OPTIONAL governed executor metadata)
// ---------------------------------------------------------------------------

/**
 * The customer-runner registration lifecycle. A runner is an
 * attributable, revocable, NON-AUTHORITATIVE executor: registration
 * metadata never grants execution, policy, budget or verification
 * authority. `revoked` is terminal.
 */
export const RUNNER_REGISTRATION_STATUSES = ["pending", "active", "suspended", "revoked"] as const;

export type RunnerRegistrationStatus = (typeof RUNNER_REGISTRATION_STATUSES)[number];

export const RUNNER_REGISTRATION_TRANSITIONS: Readonly<
  Record<RunnerRegistrationStatus, readonly RunnerRegistrationStatus[]>
> = {
  pending: ["active", "revoked"],
  active: ["suspended", "revoked"],
  suspended: ["active", "revoked"],
  revoked: [],
};

/** One governed customer-runner registration record. */
export interface RunnerRegistrationRecord {
  readonly runnerId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The runner endpoint (http(s) URL; bounded). */
  readonly endpointUrl: string;
  /** Opaque secret REFERENCE (never a value) for runner authentication. */
  readonly tokenSecretRef: string;
  readonly status: RunnerRegistrationStatus;
  /** The registrant identity (attribution). */
  readonly registeredBy: string;
  readonly registeredAt: string;
  readonly activatedAt: string | null;
  readonly suspendedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RunnerRegistrationInput {
  readonly runnerId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly endpointUrl: string;
  readonly tokenSecretRef: string;
  readonly registeredBy: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const RUNNER_ENDPOINT_PATTERN = /^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?(\/[^\s]*)?$/;

/** The secret-reference shape the runner token must carry (references only). */
const SECRET_REF_PATTERN = /^zeck-secret:\/\/[a-z0-9-]+\/[a-z0-9-]+$/;

export interface RunnerRegistrationValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/** Validate a runner registration input (pure; fail-closed on every field). */
export function validateRunnerRegistration(
  input: RunnerRegistrationInput,
): RunnerRegistrationValidation {
  const issues: string[] = [];
  if (!input.runnerId || typeof input.runnerId !== "string") {
    issues.push("runnerId is required");
  }
  if (!input.applicationId || typeof input.applicationId !== "string") {
    issues.push("applicationId is required");
  }
  if (!input.tenantId || typeof input.tenantId !== "string") {
    issues.push("tenantId is required");
  }
  if (typeof input.endpointUrl !== "string" || input.endpointUrl.length > 512) {
    issues.push("endpointUrl must be a bounded string (max 512 chars)");
  } else if (!RUNNER_ENDPOINT_PATTERN.test(input.endpointUrl)) {
    issues.push("endpointUrl must be an http(s) URL");
  }
  if (typeof input.tokenSecretRef !== "string" || input.tokenSecretRef.length > 256) {
    issues.push("tokenSecretRef must be a bounded string (max 256 chars)");
  } else if (!SECRET_REF_PATTERN.test(input.tokenSecretRef)) {
    issues.push(
      "tokenSecretRef must be an opaque zeck-secret://<environment>/<name> reference (never a value)",
    );
  }
  if (!input.registeredBy || typeof input.registeredBy !== "string") {
    issues.push("registeredBy is required (attribution)");
  }
  if (input.metadata !== undefined) {
    if (input.metadata === null || typeof input.metadata !== "object") {
      issues.push("metadata must be an object");
    } else {
      const serialized = JSON.stringify(input.metadata);
      if (serialized.length > 2048) {
        issues.push("metadata must be bounded (max 2048 canonical bytes)");
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Worker claims (runtime correlation; the quota/recovery plane)
// ---------------------------------------------------------------------------

/**
 * The claim lifecycle. A claim is NOT a lease: ownership and
 * stale-worker fencing live in the executions module's lease domain
 * (the single lease system). The claim is the worker-plane
 * CORRELATION row — it binds worker identity ↔ execution identity ↔
 * compute environment ↔ the lease epoch, carries heartbeat evidence
 * for inspection, counts against per-environment quotas and
 * per-worker concurrency, and drives bounded re-selection.
 *
 *   - `claimed`  — quota-admitted and (normally) lease-bound;
 *   - `finished` — the work outcome was committed (or converged
 *     elsewhere) — terminal, immutable outcome facts;
 *   - `abandoned`— the worker lost the work (crash, lease loss,
 *     drain deadline, retryable refusal) — terminal; the execution
 *     is recoverable by a fresh claim through re-selection.
 */
export const WORKER_CLAIM_STATUSES = ["claimed", "finished", "abandoned"] as const;

export type WorkerClaimStatus = (typeof WORKER_CLAIM_STATUSES)[number];

/** Terminal claim states are immutable (DB-trigger guarded). */
export function isTerminalClaimStatus(status: WorkerClaimStatus): boolean {
  return status === "finished" || status === "abandoned";
}

/** What the finished claim's outcome was (reference-only, bounded). */
export const WORKER_CLAIM_OUTCOMES = [
  "applied-success",
  "applied-failure",
  "converged-elsewhere",
  "not-executable",
] as const;

export type WorkerClaimOutcome = (typeof WORKER_CLAIM_OUTCOMES)[number];

/**
 * The bounded, auditable abandon causes. Every cause is explicit and
 * inspectable — a claim is never silently dropped.
 */
export const WORKER_ABANDON_CAUSES = [
  "lease-conflict",
  "lease-elapsed",
  "lease-superseded",
  "lease-released",
  "heartbeat-lost",
  "worker-drained",
  "worker-lost",
  "work-refused",
  "stale-write",
  "work-retryable",
] as const;

export type WorkerAbandonCause = (typeof WORKER_ABANDON_CAUSES)[number];

/** One durable worker claim (the runtime-correlation row). */
export interface WorkerClaimRecord {
  readonly id: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The application environment the execution runs in. */
  readonly environmentId: string;
  /** The sandbox compute environment the work executes in (quota dimension). */
  readonly computeEnvironmentId: string;
  readonly workerId: string;
  /** Monotonic claim generation for this execution (bounded by policy). */
  readonly claimEpoch: number;
  /** The executions-module lease correlation (owner + epoch, once acquired). */
  readonly leaseOwner: string | null;
  readonly leaseEpoch: number | null;
  readonly status: WorkerClaimStatus;
  readonly claimedAt: string;
  /** Monotonic claim heartbeat ledger (never regresses). */
  readonly heartbeatCount: number;
  readonly lastHeartbeatAt: string | null;
  readonly finishedAt: string | null;
  readonly outcome: WorkerClaimOutcome | null;
  /** Bounded reference-only outcome detail (digests, ids, reasons). */
  readonly outcomeDetail: Readonly<Record<string, unknown>> | null;
  readonly abandonedAt: string | null;
  readonly abandonCause: WorkerAbandonCause | null;
  /** Bounded reference-only abandon detail. */
  readonly abandonDetail: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Seam 1 — the governed dispatch re-entry (executions module implements)
// ---------------------------------------------------------------------------

/** The dispatch-delivery facts the start seam needs (from the envelope). */
export interface WorkerDispatchDelivery {
  readonly envelope: DispatchEnvelope;
}

/** The execution identity facts the seam returns (reference-only). */
export interface WorkerExecutionFacts {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  /** The execution's declared task (the work-resolution input). */
  readonly task: Readonly<Record<string, unknown>>;
}

export type DispatchStartOutcome =
  | { readonly outcome: "started"; readonly facts: WorkerExecutionFacts }
  | { readonly outcome: "already-in-flight"; readonly facts: WorkerExecutionFacts }
  | { readonly outcome: "concluded"; readonly facts: WorkerExecutionFacts }
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * The governed re-entry of one dispatch into the execution lifecycle.
 * The executions-module implementation drives the frozen transition
 * service (the single write path) with full idempotency arbitration;
 * `already-in-flight` classifies a prior start (recovery
 * re-selection), `concluded` a terminal execution, `refused` a
 * governed rejection (permanent dead-letter class).
 */
export interface ExecutionDispatchStartEffect {
  apply(
    delivery: WorkerDispatchDelivery,
    input: { readonly workerActorId: string; readonly idempotencyKey: string },
  ): Promise<DispatchStartOutcome>;
}

// ---------------------------------------------------------------------------
// Seam 2 — the durable lease authority (executions module implements)
// ---------------------------------------------------------------------------

/** The ownership claim a worker presents (the lease guard). */
export interface WorkerLeaseClaim {
  readonly ownerId: string;
  readonly epoch: number;
}

/** The observable facts of one execution lease row. */
export interface WorkerLeaseFacts {
  readonly ownerId: string;
  readonly epoch: number;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly releaseCause: string | null;
}

export interface WorkerLeaseAcquireInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly reason?: string;
}

export type WorkerLeaseAcquireOutcome =
  | {
      readonly outcome: "acquired";
      readonly claim: WorkerLeaseClaim;
      readonly expiresAt: string;
    }
  | {
      readonly outcome: "conflict";
      readonly liveOwner: string;
      readonly liveEpoch: number;
      readonly liveExpiresAt: string;
    }
  | { readonly outcome: "refused"; readonly reason: string };

export type WorkerLeaseRenewOutcome =
  | { readonly outcome: "renewed"; readonly claim: WorkerLeaseClaim; readonly expiresAt: string }
  | { readonly outcome: "stale"; readonly reason: string };

export type WorkerLeaseReleaseOutcome =
  | { readonly outcome: "released" }
  | { readonly outcome: "stale"; readonly reason: string };

/** The stale-worker fence classes (every one fails the guard closed). */
export const LEASE_FENCE_CLASSES = [
  "no-lease",
  "lease-released",
  "epoch-superseded",
  "foreign-owner",
  "lease-elapsed",
] as const;

export type LeaseFenceClass = (typeof LEASE_FENCE_CLASSES)[number];

export interface LeaseFence {
  readonly fenceClass: LeaseFenceClass;
  readonly reason: string;
}

/**
 * THE durable lease authority — the single lease system is the
 * executions module's lease domain (owner, monotonic epoch,
 * heartbeats, guarded force-release). The worker fabric composes it;
 * it never duplicates it. Every side-effecting worker write passes
 * the fence check first: a stale worker (elapsed / superseded /
 * foreign / released lease) can never commit an authoritative effect.
 */
export interface WorkerLeaseAuthority {
  acquire(input: WorkerLeaseAcquireInput): Promise<WorkerLeaseAcquireOutcome>;
  renew(input: {
    readonly applicationId: string;
    readonly executionId: string;
    readonly tenantId: string;
    readonly claim: WorkerLeaseClaim;
    readonly ttlMs: number;
    /**
     * The monotonic renewal ordinal (the claim heartbeat ledger): one
     * deterministic idempotency key per LOGICAL renewal — a retried
     * renewal replays, it never double-bumps.
     */
    readonly renewalOrdinal: number;
  }): Promise<WorkerLeaseRenewOutcome>;
  release(input: {
    readonly applicationId: string;
    readonly executionId: string;
    readonly tenantId: string;
    readonly claim: WorkerLeaseClaim;
  }): Promise<WorkerLeaseReleaseOutcome>;
  /** The pre-effect fence check: null = the claim is live and owned. */
  guard(
    applicationId: string,
    executionId: string,
    claim: WorkerLeaseClaim,
  ): Promise<LeaseFence | null>;
  /** Read the durable lease facts (recovery/inspection only). */
  inspect(applicationId: string, executionId: string): Promise<WorkerLeaseFacts | null>;
}

// ---------------------------------------------------------------------------
// Seam 3 — the work executor (sandbox module implements)
// ---------------------------------------------------------------------------

/** What the executor resolved for one execution's task (reference-only). */
export type WorkResolution =
  | {
      readonly kind: "sandbox-work";
      readonly computeEnvironmentId: string;
      /** The deterministic sandbox idempotency key (convergence anchor). */
      readonly sandboxKey: string;
    }
  | { readonly kind: "not-executable"; readonly reason: string };

/**
 * The neutral verification evidence a work observation carries. The
 * completion effect maps `met`/`unmet` onto the executions module's
 * verification discipline — a runtime/provider success signal alone
 * never declares execution completion.
 */
export interface WorkEvidence {
  readonly criterion: string;
  readonly strategy: string;
  readonly verdict: "met" | "unmet";
  /** Bounded evidence references (digests, ids — never payloads). */
  readonly evidence: readonly string[];
  /** Who/what produced the evidence (the worker identity). */
  readonly recordedBy: string;
}

export interface WorkObservation {
  readonly outcomeClass: "work-success" | "work-failure";
  readonly outputDigest: string | null;
  /** Bounded reference-only output summary (never full payloads). */
  readonly summary: Readonly<Record<string, unknown>> | null;
  /** Runtime-reported actual usage (integer micro-USD; null when unmetered). */
  readonly usageMicroUsd: string | null;
  readonly failure: {
    readonly failureClass: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly evidence: WorkEvidence;
}

/** The typed refusal kinds of the work executor (each fails closed). */
export type WorkRefusalKind = "fenced" | "interrupted" | "governed";

export type WorkExecutionOutcome =
  | { readonly outcome: "executed"; readonly observation: WorkObservation }
  | { readonly outcome: "not-executable"; readonly reason: string }
  | {
      readonly outcome: "refused";
      readonly kind: WorkRefusalKind;
      readonly reason: string;
    };

/** The resolution context: the execution's identity facts + task. */
export interface WorkResolutionRequest {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  readonly task: Readonly<Record<string, unknown>>;
}

export interface WorkExecutionRequest {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly worker: { readonly workerId: string; readonly actorId: string };
  /** The live lease claim (the executor re-checks the fence before dispatch). */
  readonly claim: WorkerLeaseClaim;
  /** Cooperative interruption (cancellation/drain/lease loss). */
  readonly signal?: AbortSignal;
}

/**
 * The work executor seam: resolve + execute the admitted work of one
 * execution through the owning module's authorities. The sandbox
 * implementation drives the FULL admission chain (policy, capability,
 * budget) and the provider registry — the worker fabric has no
 * admission powers of its own. The deterministic sandbox key makes
 * re-selection CONVERGE: a prior terminal sandbox execution replays
 * its recorded outcome; a crashed mid-dispatch attempt fails closed
 * (the honest unknown-effect barrier); duplicate provider effects are
 * structurally prevented.
 */
export interface ExecutionWorkExecutor {
  resolve(request: WorkResolutionRequest): WorkResolution;
  execute(request: WorkExecutionRequest): Promise<WorkExecutionOutcome>;
}

// ---------------------------------------------------------------------------
// Seam 4 — the lease-guarded completion (executions module implements)
// ---------------------------------------------------------------------------

export type WorkerCompletionOutcome =
  | { readonly outcome: "applied" }
  | { readonly outcome: "already-applied" }
  | { readonly outcome: "fenced"; readonly reason: string }
  | { readonly outcome: "rejected"; readonly reason: string };

export interface WorkerCompletionInput {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly claim: WorkerLeaseClaim;
  readonly workerActorId: string;
  readonly observation: WorkObservation;
}

export interface WorkerAbandonmentCompletionInput {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly workerActorId: string;
  readonly reason: string;
}

/**
 * The completion seam: commits the observed work outcome back into
 * the durable execution path THROUGH the frozen transition service
 * under the lease fence — success rides the verification discipline
 * (an observation is evidence, not authority), failure records the
 * governed failure. `fenced` means the stale-worker class: the late
 * write did NOT become authoritative. `failAbandoned` is the
 * bounded-exhaustion path (claim attempts exhausted — the honest
 * governed failure without a lease).
 */
export interface WorkerCompletionEffect {
  complete(input: WorkerCompletionInput): Promise<WorkerCompletionOutcome>;
  failAbandoned(input: WorkerAbandonmentCompletionInput): Promise<WorkerCompletionOutcome>;
}

// ---------------------------------------------------------------------------
// The worker fabric policy (bounded, observable, never a new authority)
// ---------------------------------------------------------------------------

/**
 * Bounded worker-fabric policy. Every number is a persisted-or-
 * validated bound: unbounded leases, heartbeats, concurrency,
 * attempts, drain time, payload or retained metadata are
 * unrepresentable.
 */
export interface WorkerFabricPolicy {
  /** Execution-lease TTL granted per claim acquisition. */
  readonly leaseTtlMs: number;
  /** Lease/registration heartbeat cadence. */
  readonly heartbeatIntervalMs: number;
  /** Default per-compute-environment concurrent-claim quota. */
  readonly defaultEnvironmentQuota: number;
  /** Maximum claim attempts per execution (bounded re-selection). */
  readonly maxClaimAttempts: number;
  /** Maximum in-flight work items the fabric runs concurrently per worker. */
  readonly maxInFlightPerWorker: number;
  /** Bounded drain deadline (shutdown time bound). */
  readonly maxDrainMs: number;
  /** Provider-visibility window for the claim acquisition path. */
  readonly claimVisibilityMs: number;
  /** Pull batch size bound. */
  readonly batchSize: number;
  /** A worker registration is stale after this heartbeat age. */
  readonly workerStaleAfterMs: number;
  /** Bounded reference-only outcome/detail payload (bytes). */
  readonly maxOutcomeDetailBytes: number;
  /** Terminal claim rows are retained this long, then compacted. */
  readonly claimRetentionMs: number;
}

export const WORKER_POLICY_BOUNDS = {
  leaseTtlMs: { min: 1_000, max: 3_600_000 },
  heartbeatIntervalMs: { min: 100, max: 60_000 },
  defaultEnvironmentQuota: { min: 1, max: 512 },
  maxClaimAttempts: { min: 1, max: 10 },
  maxInFlightPerWorker: { min: 1, max: 128 },
  maxDrainMs: { min: 1_000, max: 600_000 },
  claimVisibilityMs: { min: 1_000, max: 600_000 },
  batchSize: { min: 1, max: 32 },
  workerStaleAfterMs: { min: 1_000, max: 3_600_000 },
  maxOutcomeDetailBytes: { min: 128, max: 8_192 },
  claimRetentionMs: { min: 3_600_000, max: 7_776_000_000 },
} as const;

// ---------------------------------------------------------------------------
// The durable compute-plane store port (PostgreSQL authority surface)
// ---------------------------------------------------------------------------

export interface ClaimAcquisitionInput {
  readonly workerId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly computeEnvironmentId: string;
}

export type ClaimAcquisitionOutcome =
  | { readonly outcome: "admitted"; readonly claim: WorkerClaimRecord }
  | { readonly outcome: "refused"; readonly reason: ClaimRefusalReason };

/** The typed, bounded claim-gate refusals (all deterministic, inspectable). */
export type ClaimRefusalReason =
  | { readonly kind: "quota-saturated"; readonly liveClaims: number; readonly quota: number }
  | {
      readonly kind: "worker-concurrency-saturated";
      readonly liveClaims: number;
      readonly declaredConcurrency: number;
    }
  | { readonly kind: "attempts-exhausted"; readonly attempts: number; readonly bound: number }
  | { readonly kind: "worker-not-active"; readonly status: WorkerRegistrationStatus }
  | { readonly kind: "worker-unknown" }
  | { readonly kind: "duplicate-live-claim" };

export interface ClaimCompletionInput {
  readonly claimId: string;
  readonly outcome: WorkerClaimOutcome;
  readonly outcomeDetail: Readonly<Record<string, unknown>>;
}

export interface ClaimAbandonmentInput {
  readonly claimId: string;
  readonly cause: WorkerAbandonCause;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The lease correlation recorded on a claim once the lease is acquired. */
export interface ClaimLeaseCorrelation {
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
}

export interface ClaimCompactionReport {
  readonly inspected: number;
  readonly removed: number;
}

/**
 * The durable compute-plane store (schema `compute_plane`). The ONLY
 * writer of worker/claim/runner state; quota admission is atomic
 * (per-environment quota row lock + per-worker registration row lock
 * + one live claim per execution — physically enforced); terminal
 * claims are immutable; claim heartbeats are monotonic; compaction
 * removes only terminal claims of terminal executions (bounded
 * retained worker metadata, never the attempt bound).
 */
export interface ComputeWorkerStore {
  // registrations
  registerWorker(input: WorkerRegistrationInput, now: string): Promise<WorkerRegistrationRecord>;
  heartbeatWorker(workerId: string, now: string): Promise<WorkerRegistrationRecord | null>;
  beginDrain(workerId: string, now: string): Promise<WorkerRegistrationRecord | null>;
  retireWorker(
    workerId: string,
    reason: string,
    now: string,
  ): Promise<WorkerRegistrationRecord | null>;
  getWorker(workerId: string): Promise<WorkerRegistrationRecord | null>;
  listWorkers(): Promise<readonly WorkerRegistrationRecord[]>;
  /** Mark registrations whose heartbeat age exceeds the bound offline. */
  sweepStaleWorkers(
    staleAfterMs: number,
    now: string,
  ): Promise<readonly WorkerRegistrationRecord[]>;

  // claims
  acquireClaim(input: ClaimAcquisitionInput, now: string): Promise<ClaimAcquisitionOutcome>;
  recordClaimLease(
    claimId: string,
    correlation: ClaimLeaseCorrelation,
  ): Promise<WorkerClaimRecord | null>;
  heartbeatClaim(claimId: string, now: string): Promise<WorkerClaimRecord | null>;
  completeClaim(input: ClaimCompletionInput, now: string): Promise<WorkerClaimRecord | null>;
  abandonClaim(input: ClaimAbandonmentInput, now: string): Promise<WorkerClaimRecord | null>;
  getClaim(claimId: string): Promise<WorkerClaimRecord | null>;
  listClaimsByExecution(executionId: string): Promise<readonly WorkerClaimRecord[]>;
  listLiveClaims(workerId?: string): Promise<readonly WorkerClaimRecord[]>;
  /** Live claims whose heartbeat ledger is older than the bound. */
  listStaleClaims(
    heartbeatOlderThanMs: number,
    limit: number,
  ): Promise<readonly WorkerClaimRecord[]>;

  // quotas
  setEnvironmentQuota(computeEnvironmentId: string, maxConcurrentClaims: number): Promise<void>;
  getEnvironmentQuota(
    computeEnvironmentId: string,
  ): Promise<{ readonly quota: number; readonly liveClaims: number } | null>;

  // runners
  registerRunner(input: RunnerRegistrationInput, now: string): Promise<RunnerRegistrationRecord>;
  transitionRunner(
    runnerId: string,
    status: RunnerRegistrationStatus,
    input: { readonly reason?: string; readonly actorId: string; readonly now: string },
  ): Promise<RunnerRegistrationRecord>;
  getRunner(runnerId: string): Promise<RunnerRegistrationRecord | null>;
  findActiveRunner(
    applicationId: string,
    tenantId: string,
  ): Promise<RunnerRegistrationRecord | null>;

  // compaction
  compactTerminalClaims(limit: number): Promise<ClaimCompactionReport>;
}

// ---------------------------------------------------------------------------
// Fabric wiring types (composition roots)
// ---------------------------------------------------------------------------

/** Delivery-stage attempt evidence (mirrors the queue plane's shape). */
export interface EnvelopeAttemptEvidence {
  readonly stage: "publish" | "delivery" | "settle";
  readonly attemptNo: number;
  readonly outcome: "accepted" | "transient-failure" | "permanent-failure";
  readonly detail: string | null;
}

/**
 * The envelope-authority session the fabric drives (structurally
 * satisfied by the D-03 queue correlation store — the composition root
 * wires that instance here; the compute plane never re-implements it).
 * AUTHORITY FIRST: envelopes resolve from PostgreSQL before any work;
 * settlement is the transport-progress bookkeeping, never execution
 * authority.
 */
export interface DispatchEnvelopeSession {
  findByCorrelationKey(correlationKey: string): Promise<DispatchEnvelope | null>;
  markPublishAccepted(id: string, evidence: EnvelopeAttemptEvidence): Promise<DispatchEnvelope>;
  markConsumed(
    id: string,
    operationKey: string,
    evidence: EnvelopeAttemptEvidence,
  ): Promise<DispatchEnvelope>;
  recordDeliveryFailure(
    id: string,
    evidence: EnvelopeAttemptEvidence,
    retryPolicy: QueueRetryPolicy,
    options?: { readonly governedRejection?: string },
  ): Promise<DispatchEnvelope>;
  /** The explicit dead-letter path (bounded failure; terminal state). */
  deadLetter(
    id: string,
    reason:
      | "delivery-exhausted"
      | "publish-rejected"
      | "payload-mismatch"
      | "governed-rejection"
      | "unknown-envelope",
    attempts: number,
    detail: string | null,
  ): Promise<DispatchEnvelope>;
}

/**
 * The recoverable-execution source (executions module implements): the
 * read-only scan of NON-TERMINAL executions whose execution lease is
 * absent/expired/released — the re-selection candidates after worker
 * loss. The fabric adds its own live-claim filter; the source never
 * claims anything itself.
 */
export interface RecoverableExecutionSource {
  listRecoverable(options?: {
    readonly limit?: number;
    /** Scope the scan to one application (the worker's own). */
    readonly applicationId?: string;
  }): Promise<readonly WorkerExecutionFacts[]>;
}

/**
 * The execution status reader (executions module implements): the
 * cancellation/termination observation seam. The fabric polls the
 * AUTHORITATIVE status during work and converges cooperative
 * interruption — it never derives authority from the poll.
 */
export interface ExecutionStatusReader {
  getExecutionStatus(
    applicationId: string,
    executionId: string,
  ): Promise<{ readonly status: string; readonly terminal: boolean } | null>;
}

export interface ExecutionWorkerFabricDeps {
  readonly store: ComputeWorkerStore;
  /**
   * The STABLE worker-plane service actor identity (provenance on every
   * governed write the fabric drives; the per-process workerId stays
   * the claim/lease FENCING identity). The sandbox work identity is
   * actor-fingerprinted — re-selection converges only under a stable
   * service actor (a fresh process re-drives the SAME logical work).
   */
  readonly workerActorId: string;
  readonly startEffect: ExecutionDispatchStartEffect;
  readonly lease: WorkerLeaseAuthority;
  readonly work: ExecutionWorkExecutor;
  readonly completion: WorkerCompletionEffect;
  /** The D-03 correlation store session — authority-first envelope resolution. */
  readonly correlation: DispatchEnvelopeSession;
  /** The transport (pull + per-item settlement). */
  readonly transport: QueueTransportPort;
  /** The D-03 retry policy bounding envelope delivery/dead-lettering. */
  readonly retryPolicy: QueueRetryPolicy;
  /** The recovery source (executions-module re-selection scan). */
  readonly recoverySource: RecoverableExecutionSource;
  /** The cancellation/termination observation seam. */
  readonly statusReader: ExecutionStatusReader;
  readonly policy: WorkerFabricPolicy;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** Sleep seam (tests substitute a no-op; deterministic loop cadence). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The typed transport the fabric drives (pull/settle composition). */
export type WorkerTransport = QueueTransportPort;

// ---------------------------------------------------------------------------
// Disjointness anchor (pinned by the architecture suite)
// ---------------------------------------------------------------------------

/**
 * The worker-plane state vocabulary, mechanically disjoint from the
 * frozen execution states (case-insensitively) — there is no second
 * execution state machine in the worker plane.
 */
export const WORKER_PLANE_STATE_VOCABULARIES = {
  registrationStatuses: WORKER_REGISTRATION_STATUSES,
  claimStatuses: WORKER_CLAIM_STATUSES,
  claimOutcomes: WORKER_CLAIM_OUTCOMES,
  abandonCauses: WORKER_ABANDON_CAUSES,
  fenceClasses: LEASE_FENCE_CLASSES,
} as const;

/** The database dependency of the whole compute plane (the authority). */
export type ComputePlaneDatabase = DatabasePort;
