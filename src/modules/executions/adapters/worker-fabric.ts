/**
 * Worker-fabric adapters (executions module; WORK-046 / D-05) — the
 * module side of the platform compute plane's four seams plus the
 * recovery source and the status reader.
 *
 * Every adapter re-enters the EXISTING governed authorities — the
 * frozen executions transition service (the single status write path)
 * and the WORK-028 long-running lease domain (the single lease
 * system). Nothing here bypasses a gate or widens authority:
 *
 *   - `createWorkerDispatchStartEffect` — the governed re-entry of one
 *     dispatch into the lifecycle (`start`: QUEUED -> RUNNING), with
 *     the SAME command input shape and the SAME deterministic
 *     idempotency key family as the D-03 transport effect — the two
 *     consumption machineries (request-plane consumer, execution-plane
 *     worker) converge on one durable outcome per correlation key;
 *   - `createWorkerLeaseAuthority` — the durable lease acquire/renew/
 *     release/guard/inspect over the long-running service: the lease
 *     IS the single fencing system; the worker plane composes it and
 *     records only the correlation;
 *   - `createWorkerCompletionEffect` — the lease-guarded completion:
 *     success rides `verify` + `pass` (the verification binding is
 *     MANDATORY — a provider/runtime success signal alone can never
 *     complete an execution), failure rides `fail`; the bounded-
 *     exhaustion path (`failAbandoned`) records the honest governed
 *     failure WITHOUT a lease;
 *   - `SqlRecoverableExecutionSource` — the read-only re-selection
 *     scan (RUNNING executions with no live lease);
 *   - `createExecutionStatusReader` — the cancellation/termination
 *     observation seam.
 *
 * These adapters import platform types only (the
 * module-adapter-bridges-to-platform pattern); the worker plane never
 * sees the execution state vocabulary (its own vocabulary is
 * mechanically disjoint).
 */
import type {
  DispatchEnvelopeSession,
  DispatchStartOutcome,
  ExecutionDispatchStartEffect,
  ExecutionStatusReader,
  LeaseFence,
  LeaseFenceClass,
  RecoverableExecutionSource,
  WorkerAbandonmentCompletionInput,
  WorkerCompletionEffect,
  WorkerCompletionInput,
  WorkerCompletionOutcome,
  WorkerDispatchDelivery,
  WorkerExecutionFacts,
  WorkerLeaseAcquireInput,
  WorkerLeaseAcquireOutcome,
  WorkerLeaseAuthority,
  WorkerLeaseClaim,
  WorkerLeaseFacts,
  WorkerLeaseReleaseOutcome,
  WorkerLeaseRenewOutcome,
} from "../../../platform/compute/port";
import type { DatabasePort } from "../../../platform/db/port";
import type { DispatchEnvelope } from "../../../platform/queue/port";
import { PlatformError } from "../../../shared/errors";
import type { ExecutionService } from "../application/execution-service";
import type { LongRunningExecutionService } from "../application/long-running-service";
import { classifyLease, type LeaseRecord, leaseGuardRejection } from "../domain/lease";
import { isTerminal, TERMINAL_STATUSES } from "../domain/state-machine";

/**
 * Governed-path decision codes surfaced as permanent start refusals
 * (the path itself said NO — retrying cannot change the decision).
 * Codes outside this set propagate as transient (bounded retry). The
 * same set as the D-03 transport effect (the two machineries are one
 * governed path).
 */
const GOVERNED_REJECTION_CODES: ReadonlySet<string> = new Set([
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "INVALID_STATE_TRANSITION",
  "AUTHORIZATION_DENIED",
  "TENANT_SCOPE_VIOLATION",
  "IDEMPOTENCY_KEY_REUSED",
  "EXPIRED",
]);

// ---------------------------------------------------------------------------
// Seam 1 — the governed dispatch re-entry
// ---------------------------------------------------------------------------

export interface WorkerDispatchStartDeps {
  /** The FROZEN executions service — composed, never bypassed. */
  readonly service: ExecutionService;
  /** The worker's actor identity (provenance; a UUID). */
  readonly workerActorId: string;
}

/** The deterministic start key — the D-03 consume key family (convergence). */
function workerStartKey(envelope: DispatchEnvelope): string {
  return `queue-consume:${envelope.correlationKey}`;
}

export function createWorkerDispatchStartEffect(
  deps: WorkerDispatchStartDeps,
): ExecutionDispatchStartEffect {
  const service = deps.service;
  const actorId = deps.workerActorId;
  return {
    async apply(
      delivery: WorkerDispatchDelivery,
      input: { readonly workerActorId: string; readonly idempotencyKey: string },
    ): Promise<DispatchStartOutcome> {
      const envelope = delivery.envelope;
      const key = input.idempotencyKey || workerStartKey(envelope);
      // The SAME transition input shape as the D-03 transport effect
      // (command + reason): identical fingerprint under the same key
      // family — the worker's start and the request-plane consumer's
      // start are ONE logical governed operation.
      const command = {
        command: "start" as const,
        actorId: input.workerActorId || actorId,
        applicationId: envelope.applicationId,
        tenantId: envelope.tenantId,
        executionId: envelope.executionId,
        reason: "queue-transport-delivery",
      };
      try {
        const outcome = await service.transition(command, key);
        const execution = outcome.execution;
        const facts = factsOf(execution);
        return outcome.replayed
          ? classifyCurrent(execution.status, facts, "already-in-flight")
          : { outcome: "started", facts };
      } catch (error) {
        if (error instanceof PlatformError && GOVERNED_REJECTION_CODES.has(error.code)) {
          const current = await service.getExecution(envelope.applicationId, envelope.executionId);
          if (current !== null) {
            const facts = factsOf(current);
            return classifyCurrent(current.status, facts, "refused");
          }
          return { outcome: "refused", reason: `${error.code}: ${error.message}` };
        }
        // Transient/unknown failures propagate: the worker's bounded
        // delivery budget decides retry vs dead-letter.
        throw error;
      }
    },
  };
}

function factsOf(execution: {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  readonly task: Readonly<Record<string, unknown>>;
}): WorkerExecutionFacts {
  return {
    executionId: execution.id,
    applicationId: execution.applicationId,
    tenantId: execution.tenantId,
    environmentId: execution.environmentId,
    task: execution.task,
  };
}

/**
 * Classify the CURRENT authoritative status after a governed
 * rejection or a replay: terminal = concluded; moved-past-QUEUED =
 * already-in-flight; still-QUEUED = the governed refusal.
 */
function classifyCurrent(
  status: string,
  facts: WorkerExecutionFacts,
  refusedAs: "already-in-flight" | "refused",
): DispatchStartOutcome {
  if (TERMINAL_STATUSES.includes(status.toUpperCase() as never)) {
    return { outcome: "concluded", facts };
  }
  if (
    status === "QUEUED" ||
    status === "CREATED" ||
    status === "AUTHORIZED" ||
    status === "PLANNING"
  ) {
    return refusedAs === "refused"
      ? {
          outcome: "refused",
          reason: `the governed path rejected the dispatch (execution is ${status})`,
        }
      : { outcome: "already-in-flight", facts };
  }
  // RUNNING / WAITING_* / VERIFYING / REPLANNING: the execution moved
  // past admission — a prior start is in flight (recovery
  // re-selection converges here).
  return { outcome: "already-in-flight", facts };
}

// ---------------------------------------------------------------------------
// Seam 2 — the durable lease authority (over the single lease system)
// ---------------------------------------------------------------------------

export interface WorkerLeaseAuthorityDeps {
  /** The WORK-028 long-running service — the single lease system. */
  readonly service: LongRunningExecutionService;
}

export function createWorkerLeaseAuthority(deps: WorkerLeaseAuthorityDeps): WorkerLeaseAuthority {
  const service = deps.service;
  const iso = () => new Date().toISOString();

  const acquire = async (input: WorkerLeaseAcquireInput): Promise<WorkerLeaseAcquireOutcome> => {
    // The deterministic acquire key: one per (execution, worker,
    // claim-attempt ordinal) — the claim epoch is unique per
    // execution, so a retried acquire under the same claim replays.
    const key = `worker-lease-acquire:${input.executionId}:${input.ownerId}`;
    try {
      const outcome = await service.acquireLease(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: { actorId: input.ownerId, tenantId: input.tenantId },
          ownerId: input.ownerId,
          ttlMs: input.ttlMs,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        key,
      );
      return {
        outcome: "acquired",
        claim: { ownerId: outcome.lease.ownerId, epoch: outcome.lease.epoch },
        expiresAt: outcome.lease.expiresAt,
      };
    } catch (error) {
      if (error instanceof PlatformError && error.code === "POLICY_DENIED") {
        return { outcome: "refused", reason: error.message };
      }
      if (error instanceof PlatformError && error.code === "INVALID_STATE_TRANSITION") {
        // Lease conflict (fail closed) or a terminal execution: read
        // the authoritative row and classify honestly.
        const lease = await service.getLease(input.applicationId, input.executionId);
        if (
          lease !== null &&
          classifyLease(lease, iso()) === "held" &&
          lease.ownerId !== input.ownerId
        ) {
          return {
            outcome: "conflict",
            liveOwner: lease.ownerId,
            liveEpoch: lease.epoch,
            liveExpiresAt: lease.expiresAt,
          };
        }
        return { outcome: "refused", reason: error.message };
      }
      throw error;
    }
  };

  return {
    acquire,

    async renew(input: {
      readonly applicationId: string;
      readonly executionId: string;
      readonly tenantId: string;
      readonly claim: WorkerLeaseClaim;
      readonly ttlMs: number;
      readonly renewalOrdinal: number;
    }): Promise<WorkerLeaseRenewOutcome> {
      const key = `worker-lease-renew:${input.executionId}:${input.claim.epoch}:${input.renewalOrdinal}`;
      try {
        const outcome = await service.renewLease(
          {
            applicationId: input.applicationId,
            executionId: input.executionId,
            actor: { actorId: input.claim.ownerId, tenantId: input.tenantId },
            worker: { ownerId: input.claim.ownerId, epoch: input.claim.epoch },
            ttlMs: input.ttlMs,
          },
          key,
        );
        return {
          outcome: "renewed",
          claim: { ownerId: outcome.lease.ownerId, epoch: outcome.lease.epoch },
          expiresAt: outcome.lease.expiresAt,
        };
      } catch (error) {
        if (error instanceof PlatformError) {
          return { outcome: "stale", reason: error.message };
        }
        throw error;
      }
    },

    async release(input: {
      readonly applicationId: string;
      readonly executionId: string;
      readonly tenantId: string;
      readonly claim: WorkerLeaseClaim;
    }): Promise<WorkerLeaseReleaseOutcome> {
      const key = `worker-lease-release:${input.executionId}:${input.claim.epoch}`;
      try {
        await service.releaseLease(
          {
            applicationId: input.applicationId,
            executionId: input.executionId,
            actor: { actorId: input.claim.ownerId, tenantId: input.tenantId },
            worker: { ownerId: input.claim.ownerId, epoch: input.claim.epoch },
            cause: "worker-released",
          },
          key,
        );
        return { outcome: "released" };
      } catch (error) {
        if (error instanceof PlatformError) {
          return { outcome: "stale", reason: error.message };
        }
        throw error;
      }
    },

    async guard(
      applicationId: string,
      executionId: string,
      claim: WorkerLeaseClaim,
    ): Promise<LeaseFence | null> {
      const lease = await service.getLease(applicationId, executionId);
      const rejection = leaseGuardRejection(
        lease as LeaseRecord | null,
        { ownerId: claim.ownerId, epoch: claim.epoch },
        iso(),
      );
      if (rejection === null) {
        return null;
      }
      return { fenceClass: fenceClassOf(rejection.code, lease), reason: rejection.reason };
    },

    async inspect(applicationId: string, executionId: string): Promise<WorkerLeaseFacts | null> {
      const lease = await service.getLease(applicationId, executionId);
      if (lease === null) {
        return null;
      }
      return leaseFactsOf(lease);
    },
  };
}

/** Map the domain rejection code onto the neutral fence classes. */
function fenceClassOf(code: string, lease: LeaseRecord | null): LeaseFenceClass {
  if (lease === null) {
    return "no-lease";
  }
  if (lease.releasedAt !== null) {
    return "lease-released";
  }
  if (code === "EXPIRED") {
    return "lease-elapsed";
  }
  // INVALID_STATE_TRANSITION: epoch mismatch (superseded) or a
  // foreign live owner.
  return "epoch-superseded";
}

function leaseFactsOf(lease: LeaseRecord): WorkerLeaseFacts {
  return {
    ownerId: lease.ownerId,
    epoch: lease.epoch,
    expiresAt: lease.expiresAt,
    releasedAt: lease.releasedAt,
    releaseCause: lease.releaseCause,
  };
}

// ---------------------------------------------------------------------------
// Seam 4 — the lease-guarded completion
// ---------------------------------------------------------------------------

export interface WorkerCompletionDeps {
  /** The FROZEN executions service — the single status write path. */
  readonly service: ExecutionService;
  /** The lease authority (the fence check before every write). */
  readonly lease: WorkerLeaseAuthority;
}

export function createWorkerCompletionEffect(deps: WorkerCompletionDeps): WorkerCompletionEffect {
  const service = deps.service;
  const lease = deps.lease;
  const iso = () => new Date().toISOString();

  /** Classify a governed rejection against the CURRENT durable status. */
  const classifyRejection = async (
    applicationId: string,
    executionId: string,
    error: PlatformError,
  ): Promise<WorkerCompletionOutcome> => {
    const current = await service.getExecution(applicationId, executionId);
    if (current !== null && isTerminal(current.status)) {
      // The execution already converged (another path finished it):
      // the late completion is NOT authoritative — it converged
      // elsewhere.
      return { outcome: "already-applied" };
    }
    return { outcome: "rejected", reason: `${error.code}: ${error.message}` };
  };

  const complete = async (input: WorkerCompletionInput): Promise<WorkerCompletionOutcome> => {
    const executionId = input.executionId;

    // THE FENCE: a stale worker's completion NEVER becomes
    // authoritative (checked before every write below).
    const fence = await lease.guard(input.applicationId, executionId, input.claim);
    if (fence !== null) {
      return { outcome: "fenced", reason: `${fence.fenceClass}: ${fence.reason}` };
    }

    if (input.observation.outcomeClass === "work-success") {
      // Success rides the verification discipline: RUNNING -> VERIFYING
      // -> COMPLETED, bound to at least one PASS verification result.
      // A runtime/provider success signal alone NEVER completes.
      try {
        await service.transition(
          {
            command: "verify",
            actorId: input.workerActorId,
            applicationId: input.applicationId,
            tenantId: input.tenantId,
            executionId,
            reason: "worker-completion",
          },
          `worker-verify:${executionId}`,
        );
      } catch (error) {
        if (error instanceof PlatformError && GOVERNED_REJECTION_CODES.has(error.code)) {
          return classifyRejection(input.applicationId, executionId, error);
        }
        throw error;
      }
      const evidence = input.observation.evidence;
      try {
        await service.transition(
          {
            command: "pass",
            actorId: input.workerActorId,
            applicationId: input.applicationId,
            tenantId: input.tenantId,
            executionId,
            verificationResults: [
              {
                criterionId: evidence.criterion,
                strategy: evidence.strategy,
                status: "PASS" as const,
                ...(evidence.evidence.length > 0 ? { evidence: [...evidence.evidence] } : {}),
                recordedBy: evidence.recordedBy,
              },
            ],
            reason: "worker-completion",
          },
          `worker-pass:${executionId}`,
        );
        return { outcome: "applied" };
      } catch (error) {
        if (error instanceof PlatformError && GOVERNED_REJECTION_CODES.has(error.code)) {
          return classifyRejection(input.applicationId, executionId, error);
        }
        throw error;
      }
    }

    // Failure: the governed failure with the observed evidence.
    const failure = input.observation.failure;
    try {
      await service.transition(
        {
          command: "fail",
          actorId: input.workerActorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId,
          ...(failure === null
            ? {}
            : {
                verificationResults: [
                  {
                    criterionId: input.observation.evidence.criterion,
                    strategy: input.observation.evidence.strategy,
                    status: "FAIL" as const,
                    recordedBy: input.observation.evidence.recordedBy,
                    ...(failure.message === ""
                      ? {}
                      : { evidence: [failure.message.slice(0, 200)] }),
                  },
                ],
              }),
          reason: failure === null ? "worker-completion" : `worker-failure:${failure.failureClass}`,
        },
        `worker-fail:${executionId}`,
      );
      return { outcome: "applied" };
    } catch (error) {
      if (error instanceof PlatformError && GOVERNED_REJECTION_CODES.has(error.code)) {
        return classifyRejection(input.applicationId, executionId, error);
      }
      throw error;
    }
  };

  const failAbandoned = async (
    input: WorkerAbandonmentCompletionInput,
  ): Promise<WorkerCompletionOutcome> => {
    // The bounded-exhaustion path: the honest governed failure WITHOUT
    // a lease (the claim budget was exhausted — never an authority
    // claim, never a silent drop).
    void iso;
    try {
      await service.transition(
        {
          command: "fail",
          actorId: input.workerActorId,
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          executionId: input.executionId,
          reason: `worker-abandoned:${input.reason.slice(0, 160)}`,
        },
        `worker-fail-abandoned:${input.executionId}`,
      );
      return { outcome: "applied" };
    } catch (error) {
      if (error instanceof PlatformError && GOVERNED_REJECTION_CODES.has(error.code)) {
        return classifyRejection(input.applicationId, input.executionId, error);
      }
      throw error;
    }
  };

  return { complete, failAbandoned };
}

// ---------------------------------------------------------------------------
// The recovery source (read-only re-selection scan)
// ---------------------------------------------------------------------------

interface RecoverableRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly environment_id: string | null;
  readonly task: Record<string, unknown>;
  readonly updated_at: Date | string;
}

export class SqlRecoverableExecutionSource implements RecoverableExecutionSource {
  constructor(private readonly db: DatabasePort) {}

  /**
   * RUNNING executions whose execution lease is absent, expired or
   * released — the re-selection candidates after worker loss. The
   * fabric adds its own live-claim filter; this scan never claims.
   */
  async listRecoverable(options?: {
    readonly limit?: number;
    readonly applicationId?: string;
  }): Promise<readonly WorkerExecutionFacts[]> {
    const limit = options?.limit ?? 32;
    const applicationId = options?.applicationId;
    const result = await this.db.execute<RecoverableRow>({
      sql: `SELECT e.id, e.application_id, e.tenant_id, e.environment_id, e.task, e.updated_at
FROM executions.executions e
LEFT JOIN executions.execution_leases l
    ON l.execution_id = e.id AND l.application_id = e.application_id
WHERE e.status = 'RUNNING'
  AND ($2::uuid IS NULL OR e.application_id = $2::uuid)
  AND (l.execution_id IS NULL OR l.released_at IS NOT NULL OR l.expires_at <= now())
ORDER BY e.updated_at ASC
LIMIT $1`,
      parameters: [limit, applicationId ?? null],
    });
    return result.rows.map((row) => ({
      executionId: row.id,
      applicationId: row.application_id,
      tenantId: row.tenant_id,
      environmentId: row.environment_id,
      task: row.task ?? {},
    }));
  }
}

/** Convenience factory matching the module conventions. */
export function createRecoverableExecutionSource(db: DatabasePort): RecoverableExecutionSource {
  return new SqlRecoverableExecutionSource(db);
}

// ---------------------------------------------------------------------------
// The status reader (cancellation/termination observation)
// ---------------------------------------------------------------------------

export function createExecutionStatusReader(service: ExecutionService): ExecutionStatusReader {
  return {
    async getExecutionStatus(applicationId, executionId) {
      const execution = await service.getExecution(applicationId, executionId);
      if (execution === null) {
        return null;
      }
      return { status: execution.status, terminal: isTerminal(execution.status) };
    },
  };
}

// ---------------------------------------------------------------------------
// The envelope session bridge (composition convenience)
// ---------------------------------------------------------------------------

/**
 * The structural bridge: the D-03 queue correlation store satisfies
 * `DispatchEnvelopeSession` by construction. This helper exists only
 * to make the composition root's wiring explicit and type-checked.
 */
export function envelopeSessionOf(
  store: Pick<
    DispatchEnvelopeSession,
    | "findByCorrelationKey"
    | "markPublishAccepted"
    | "markConsumed"
    | "recordDeliveryFailure"
    | "deadLetter"
  >,
): DispatchEnvelopeSession {
  return store;
}
