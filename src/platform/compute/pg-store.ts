/**
 * The durable compute-plane store (platform compute plane; WORK-046,
 * D-05) over the provider-neutral platform `DatabasePort`.
 *
 * THE ONLY writer of worker/claim/runner/quota state (schema
 * `compute_plane`, migration 0028). This is worker-plane COORDINATION
 * state, never execution authority: the claim outcomes recorded here
 * are what the WORKER PLANE did with its correlation row — the
 * authoritative execution outcome stays behind the executions
 * module's frozen single write path, and the lease system stays
 * there too (this store records only the lease CORRELATION on a
 * claim, set exactly once).
 *
 * ADMISSION IS ATOMIC: `acquireClaim` locks the worker registration
 * row (per-worker live-claim bound + active status), locks the
 * environment quota row (per-environment quota) and admits the claim
 * with its epoch = prior-claims + 1 inside ONE transaction — the
 * one-live-claim-per-execution partial unique index physically
 * arbitrates the last race (a concurrent duplicate converges to the
 * typed `duplicate-live-claim` refusal).
 *
 * No driver import: `pg` is owned by `src/platform/db/` (SDK boundary
 * table). Detail payloads are reference-only (ids, keys, digests,
 * bounded reasons) — secret values are unrepresentable in this store's
 * vocabulary.
 */
import type { DatabasePort } from "../db/port";
import {
  type ClaimAbandonmentInput,
  type ClaimAcquisitionInput,
  type ClaimAcquisitionOutcome,
  type ClaimCompactionReport,
  type ClaimCompletionInput,
  type ClaimLeaseCorrelation,
  type ClaimRefusalReason,
  type ComputeWorkerStore,
  type RunnerRegistrationInput,
  type RunnerRegistrationRecord,
  type RunnerRegistrationStatus,
  WORKER_ABANDON_CAUSES,
  WORKER_CLAIM_OUTCOMES,
  WORKER_POLICY_BOUNDS,
  type WorkerAbandonCause,
  type WorkerClaimOutcome,
  type WorkerClaimRecord,
  type WorkerRegistrationInput,
  type WorkerRegistrationRecord,
} from "./port";

/** Fail-closed store configuration error (never a silent default). */
export class ComputeStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeStoreConfigError";
  }
}

export interface SqlComputeWorkerStoreDeps {
  readonly db: DatabasePort;
  /** The store clock (the compaction retention cutoff; default: real time). */
  readonly now?: () => Date;
  /**
   * The bounded re-selection budget (max claim attempts per
   * execution) — persisted policy, enforced at claim admission.
   */
  readonly maxClaimAttempts: number;
  /** The default per-environment quota applied when no quota row exists. */
  readonly defaultEnvironmentQuota: number;
  /** Terminal-claim retention bound for the compaction path (ms). */
  readonly claimRetentionMs: number;
  readonly generateId: () => string;
}

interface WorkerRow {
  readonly worker_id: string;
  readonly application_id: string;
  readonly kind: string;
  readonly runner_id: string | null;
  readonly status: string;
  readonly declared_concurrency: number;
  readonly heartbeat_count: number;
  readonly registered_at: Date | string;
  readonly last_heartbeat_at: Date | string;
  readonly drain_requested_at: Date | string | null;
  readonly went_offline_at: Date | string | null;
  readonly offline_reason: string | null;
  readonly metadata: Record<string, unknown>;
}

interface RunnerRow {
  readonly runner_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly endpoint_url: string;
  readonly token_secret_ref: string;
  readonly status: string;
  readonly registered_by: string;
  readonly registered_at: Date | string;
  readonly activated_at: Date | string | null;
  readonly suspended_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly revocation_reason: string | null;
  readonly metadata: Record<string, unknown>;
}

interface ClaimRow {
  readonly id: string;
  readonly execution_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly environment_id: string | null;
  readonly compute_environment_id: string;
  readonly worker_id: string;
  readonly claim_epoch: number;
  readonly lease_owner: string | null;
  readonly lease_epoch: number | null;
  readonly status: string;
  readonly claimed_at: Date | string;
  readonly heartbeat_count: number;
  readonly last_heartbeat_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly outcome: string | null;
  readonly outcome_detail: Record<string, unknown> | null;
  readonly abandoned_at: Date | string | null;
  readonly abandon_cause: string | null;
  readonly abandon_detail: Record<string, unknown> | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const iso = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
};

const workerOf = (row: WorkerRow): WorkerRegistrationRecord => ({
  workerId: row.worker_id,
  applicationId: row.application_id,
  kind: row.kind as WorkerRegistrationRecord["kind"],
  runnerId: row.runner_id,
  status: row.status as WorkerRegistrationRecord["status"],
  declaredConcurrency: row.declared_concurrency,
  registeredAt: iso(row.registered_at) as string,
  lastHeartbeatAt: iso(row.last_heartbeat_at) as string,
  heartbeatCount: row.heartbeat_count,
  drainRequestedAt: iso(row.drain_requested_at),
  wentOfflineAt: iso(row.went_offline_at),
  offlineReason: row.offline_reason,
  metadata: row.metadata ?? {},
});

const runnerOf = (row: RunnerRow): RunnerRegistrationRecord => ({
  runnerId: row.runner_id,
  applicationId: row.application_id,
  tenantId: row.tenant_id,
  endpointUrl: row.endpoint_url,
  tokenSecretRef: row.token_secret_ref,
  status: row.status as RunnerRegistrationRecord["status"],
  registeredBy: row.registered_by,
  registeredAt: iso(row.registered_at) as string,
  activatedAt: iso(row.activated_at),
  suspendedAt: iso(row.suspended_at),
  revokedAt: iso(row.revoked_at),
  revocationReason: row.revocation_reason,
  metadata: row.metadata ?? {},
});

const claimOf = (row: ClaimRow): WorkerClaimRecord => ({
  id: row.id,
  executionId: row.execution_id,
  applicationId: row.application_id,
  tenantId: row.tenant_id,
  environmentId: row.environment_id ?? "",
  computeEnvironmentId: row.compute_environment_id,
  workerId: row.worker_id,
  claimEpoch: row.claim_epoch,
  leaseOwner: row.lease_owner,
  leaseEpoch: row.lease_epoch,
  status: row.status as WorkerClaimRecord["status"],
  claimedAt: iso(row.claimed_at) as string,
  heartbeatCount: row.heartbeat_count,
  lastHeartbeatAt: iso(row.last_heartbeat_at),
  finishedAt: iso(row.finished_at),
  outcome: row.outcome as WorkerClaimOutcome | null,
  outcomeDetail: row.outcome_detail,
  abandonedAt: iso(row.abandoned_at),
  abandonCause: row.abandon_cause as WorkerAbandonCause | null,
  abandonDetail: row.abandon_detail,
  createdAt: iso(row.created_at) as string,
  updatedAt: iso(row.updated_at) as string,
});

/** Bound a reference-only detail payload to the schema byte bound. */
function boundedDetail(
  detail: Readonly<Record<string, unknown>> | undefined,
  maxBytes: number,
): Record<string, unknown> {
  if (detail === undefined || detail === null) {
    return {};
  }
  const serialized = JSON.stringify(detail);
  if (serialized.length > maxBytes) {
    return { truncated: true, bytes: serialized.length };
  }
  return { ...(detail as Record<string, unknown>) };
}

export class SqlComputeWorkerStore implements ComputeWorkerStore {
  private readonly db: DatabasePort;
  private readonly maxClaimAttempts: number;
  private readonly defaultQuota: number;
  private readonly claimRetentionMs: number;
  private readonly generateId: () => string;
  private readonly clock: () => Date;

  constructor(deps: SqlComputeWorkerStoreDeps) {
    if (
      !Number.isInteger(deps.maxClaimAttempts) ||
      deps.maxClaimAttempts < WORKER_POLICY_BOUNDS.maxClaimAttempts.min ||
      deps.maxClaimAttempts > WORKER_POLICY_BOUNDS.maxClaimAttempts.max
    ) {
      throw new ComputeStoreConfigError(
        `maxClaimAttempts must be bounded [${WORKER_POLICY_BOUNDS.maxClaimAttempts.min}, ${WORKER_POLICY_BOUNDS.maxClaimAttempts.max}]`,
      );
    }
    if (
      !Number.isInteger(deps.defaultEnvironmentQuota) ||
      deps.defaultEnvironmentQuota < WORKER_POLICY_BOUNDS.defaultEnvironmentQuota.min ||
      deps.defaultEnvironmentQuota > WORKER_POLICY_BOUNDS.defaultEnvironmentQuota.max
    ) {
      throw new ComputeStoreConfigError("defaultEnvironmentQuota must be bounded [1, 512]");
    }
    if (
      !Number.isInteger(deps.claimRetentionMs) ||
      deps.claimRetentionMs < WORKER_POLICY_BOUNDS.claimRetentionMs.min
    ) {
      throw new ComputeStoreConfigError("claimRetentionMs must be a bounded positive integer");
    }
    this.db = deps.db;
    this.maxClaimAttempts = deps.maxClaimAttempts;
    this.defaultQuota = deps.defaultEnvironmentQuota;
    this.claimRetentionMs = deps.claimRetentionMs;
    this.generateId = deps.generateId;
    this.clock = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------- registrations

  async registerWorker(
    input: WorkerRegistrationInput,
    now: string,
  ): Promise<WorkerRegistrationRecord> {
    if (input.kind === "customer-runner" && !input.runnerId) {
      throw new ComputeStoreConfigError(
        "customer-runner workers require the governed runnerId binding",
      );
    }
    if (input.kind === "first-party" && input.runnerId !== undefined) {
      throw new ComputeStoreConfigError("first-party workers never bind a runner registration");
    }
    if (
      !Number.isInteger(input.declaredConcurrency) ||
      input.declaredConcurrency < WORKER_POLICY_BOUNDS.maxInFlightPerWorker.min ||
      input.declaredConcurrency > WORKER_POLICY_BOUNDS.maxInFlightPerWorker.max
    ) {
      throw new ComputeStoreConfigError(
        "declaredConcurrency must be bounded [1, 128] (the maxInFlightPerWorker bound)",
      );
    }
    const metadata = boundedDetail(input.metadata, 2048);
    const inserted = await this.db.transaction(async (tx) => {
      const result = await tx.execute<WorkerRow>({
        sql: `INSERT INTO compute_plane.worker_registrations
(worker_id, application_id, kind, runner_id, status, declared_concurrency, registered_at, last_heartbeat_at, metadata)
VALUES ($1, $2, $3, $4, 'active', $5, $6, $6, $7::jsonb)
ON CONFLICT (worker_id) DO NOTHING
RETURNING *`,
        parameters: [
          input.workerId,
          input.applicationId,
          input.kind,
          input.runnerId ?? null,
          input.declaredConcurrency,
          now,
          JSON.stringify(metadata),
        ],
      });
      if (result.rows.length > 0) {
        return result.rows[0] as WorkerRow;
      }
      // Registration is idempotent by identity: re-registering the SAME
      // identity (identical core) replays the durable row; a restarted
      // process MUST register a NEW identity (offline rows reject
      // re-activation at the trigger, and the returned row makes the
      // status observable).
      const existing = await tx.execute<WorkerRow>({
        sql: `SELECT * FROM compute_plane.worker_registrations WHERE worker_id = $1`,
        parameters: [input.workerId],
      });
      return existing.rows[0] ?? null;
    });
    if (inserted === null) {
      throw new ComputeStoreConfigError("worker registration failed (no row)");
    }
    return workerOf(inserted);
  }

  async heartbeatWorker(workerId: string, now: string): Promise<WorkerRegistrationRecord | null> {
    const result = await this.db.execute<WorkerRow>({
      sql: `UPDATE compute_plane.worker_registrations
SET heartbeat_count = heartbeat_count + 1, last_heartbeat_at = $2
WHERE worker_id = $1 AND status IN ('active', 'draining')
RETURNING *`,
      parameters: [workerId, now],
    });
    return result.rows.length > 0 ? workerOf(result.rows[0] as WorkerRow) : null;
  }

  async beginDrain(workerId: string, now: string): Promise<WorkerRegistrationRecord | null> {
    const result = await this.db.execute<WorkerRow>({
      sql: `UPDATE compute_plane.worker_registrations
SET status = 'draining', drain_requested_at = $2
WHERE worker_id = $1 AND status = 'active'
RETURNING *`,
      parameters: [workerId, now],
    });
    return result.rows.length > 0 ? workerOf(result.rows[0] as WorkerRow) : null;
  }

  async retireWorker(
    workerId: string,
    reason: string,
    now: string,
  ): Promise<WorkerRegistrationRecord | null> {
    const bounded = reason.slice(0, 200);
    const result = await this.db.execute<WorkerRow>({
      sql: `UPDATE compute_plane.worker_registrations
SET status = 'offline', went_offline_at = $2, offline_reason = $3
WHERE worker_id = $1 AND status IN ('active', 'draining')
RETURNING *`,
      parameters: [workerId, now, bounded],
    });
    return result.rows.length > 0 ? workerOf(result.rows[0] as WorkerRow) : null;
  }

  async getWorker(workerId: string): Promise<WorkerRegistrationRecord | null> {
    const result = await this.db.execute<WorkerRow>({
      sql: `SELECT * FROM compute_plane.worker_registrations WHERE worker_id = $1`,
      parameters: [workerId],
    });
    return result.rows.length > 0 ? workerOf(result.rows[0] as WorkerRow) : null;
  }

  async listWorkers(): Promise<readonly WorkerRegistrationRecord[]> {
    const result = await this.db.execute<WorkerRow>({
      sql: `SELECT * FROM compute_plane.worker_registrations ORDER BY registered_at, worker_id`,
      parameters: [],
    });
    return result.rows.map((row) => workerOf(row));
  }

  async sweepStaleWorkers(
    staleAfterMs: number,
    now: string,
  ): Promise<readonly WorkerRegistrationRecord[]> {
    const result = await this.db.execute<WorkerRow>({
      sql: `UPDATE compute_plane.worker_registrations
SET status = 'offline', went_offline_at = $1, offline_reason = 'heartbeat-age-exceeded'
WHERE worker_id IN (
    SELECT worker_id FROM compute_plane.worker_registrations
    WHERE status IN ('active', 'draining')
      AND last_heartbeat_at < ($1::timestamptz - ($2 || ' milliseconds')::interval)
    ORDER BY worker_id
    FOR UPDATE SKIP LOCKED
)
RETURNING *`,
      parameters: [now, staleAfterMs],
    });
    return result.rows.map((row) => workerOf(row));
  }

  // -------------------------------------------------------------------- claims

  async acquireClaim(input: ClaimAcquisitionInput, now: string): Promise<ClaimAcquisitionOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        // 1. Lock + validate the worker registration row: the worker
        //    must be active (draining/offline admit nothing) and its
        //    live claims must stay under the declared concurrency.
        const worker = await tx.execute<WorkerRow>({
          sql: `SELECT * FROM compute_plane.worker_registrations WHERE worker_id = $1 FOR UPDATE`,
          parameters: [input.workerId],
        });
        if (worker.rows.length === 0) {
          return refused({ kind: "worker-unknown" });
        }
        const workerRow = worker.rows[0] as WorkerRow;
        if (workerRow.status !== "active") {
          return refused({ kind: "worker-not-active", status: workerRow.status as never });
        }
        const liveOfWorker = await tx.execute<{ readonly count: string }>({
          sql: `SELECT count(*) AS count FROM compute_plane.worker_claims
WHERE worker_id = $1 AND status = 'claimed'`,
          parameters: [input.workerId],
        });
        const liveClaims = Number(liveOfWorker.rows[0]?.count ?? 0);
        if (liveClaims >= workerRow.declared_concurrency) {
          return refused({
            kind: "worker-concurrency-saturated",
            liveClaims,
            declaredConcurrency: workerRow.declared_concurrency,
          });
        }

        // 2. Lock the environment quota row (inserting the default row
        //    under the lock when absent) and enforce the quota.
        const quotaRow = await tx.execute<{ readonly max_concurrent_claims: number }>({
          sql: `INSERT INTO compute_plane.environment_quotas (compute_environment_id, application_id, max_concurrent_claims, updated_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (compute_environment_id) DO UPDATE SET updated_at = compute_plane.environment_quotas.updated_at
RETURNING max_concurrent_claims`,
          parameters: [input.computeEnvironmentId, input.applicationId, this.defaultQuota, now],
        });
        const quota = quotaRow.rows[0]?.max_concurrent_claims ?? this.defaultQuota;
        const liveOfEnv = await tx.execute<{ readonly count: string }>({
          sql: `SELECT count(*) AS count FROM compute_plane.worker_claims
WHERE compute_environment_id = $1 AND status = 'claimed'`,
          parameters: [input.computeEnvironmentId],
        });
        const liveEnv = Number(liveOfEnv.rows[0]?.count ?? 0);
        if (liveEnv >= quota) {
          return refused({ kind: "quota-saturated", liveClaims: liveEnv, quota });
        }

        // 3. The bounded re-selection budget: prior claims of THIS
        //    execution (terminal claims are retained — the epoch is the
        //    attempt count).
        const prior = await tx.execute<{ readonly count: string }>({
          sql: `SELECT count(*) AS count FROM compute_plane.worker_claims WHERE execution_id = $1`,
          parameters: [input.executionId],
        });
        const attempts = Number(prior.rows[0]?.count ?? 0);
        if (attempts >= this.maxClaimAttempts) {
          return refused({ kind: "attempts-exhausted", attempts, bound: this.maxClaimAttempts });
        }

        // 4. Admit the claim (the partial unique index arbitrates the
        //    final one-live-claim race; the epoch sequence is unique).
        const claimId = this.generateId();
        const inserted = await tx.execute<ClaimRow>({
          sql: `INSERT INTO compute_plane.worker_claims
(id, execution_id, application_id, tenant_id, environment_id, compute_environment_id, worker_id, claim_epoch, status, claimed_at, last_heartbeat_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'claimed', $9, $9)
RETURNING *`,
          parameters: [
            claimId,
            input.executionId,
            input.applicationId,
            input.tenantId,
            input.environmentId === "" ? null : input.environmentId,
            input.computeEnvironmentId,
            input.workerId,
            attempts + 1,
            now,
          ],
        });
        return { outcome: "admitted", claim: claimOf(inserted.rows[0] as ClaimRow) };
      });
    } catch (error) {
      // The one-live-claim partial unique index fired: a concurrent
      // duplicate converged.
      if (error instanceof Error && error.message.includes("one_live_claim_per_execution")) {
        return refused({ kind: "duplicate-live-claim" });
      }
      throw error;
    }
  }

  async recordClaimLease(
    claimId: string,
    correlation: ClaimLeaseCorrelation,
  ): Promise<WorkerClaimRecord | null> {
    const result = await this.db.execute<ClaimRow>({
      sql: `UPDATE compute_plane.worker_claims
SET lease_owner = $2, lease_epoch = $3, updated_at = now()
WHERE id = $1 AND status = 'claimed' AND lease_owner IS NULL
RETURNING *`,
      parameters: [claimId, correlation.leaseOwner, correlation.leaseEpoch],
    });
    return result.rows.length > 0 ? claimOf(result.rows[0] as ClaimRow) : null;
  }

  async heartbeatClaim(claimId: string, now: string): Promise<WorkerClaimRecord | null> {
    const result = await this.db.execute<ClaimRow>({
      sql: `UPDATE compute_plane.worker_claims
SET heartbeat_count = heartbeat_count + 1, last_heartbeat_at = $2, updated_at = now()
WHERE id = $1 AND status = 'claimed'
RETURNING *`,
      parameters: [claimId, now],
    });
    return result.rows.length > 0 ? claimOf(result.rows[0] as ClaimRow) : null;
  }

  async completeClaim(input: ClaimCompletionInput, now: string): Promise<WorkerClaimRecord | null> {
    if (!(WORKER_CLAIM_OUTCOMES as readonly string[]).includes(input.outcome)) {
      throw new ComputeStoreConfigError(`unknown claim outcome ${String(input.outcome)}`);
    }
    const detail = boundedDetail(input.outcomeDetail, 8192);
    const result = await this.db.execute<ClaimRow>({
      sql: `UPDATE compute_plane.worker_claims
SET status = 'finished', finished_at = $2, outcome = $3, outcome_detail = $4::jsonb, updated_at = now()
WHERE id = $1 AND status = 'claimed'
RETURNING *`,
      parameters: [input.claimId, now, input.outcome, JSON.stringify(detail)],
    });
    return result.rows.length > 0 ? claimOf(result.rows[0] as ClaimRow) : null;
  }

  async abandonClaim(input: ClaimAbandonmentInput, now: string): Promise<WorkerClaimRecord | null> {
    if (!(WORKER_ABANDON_CAUSES as readonly string[]).includes(input.cause)) {
      throw new ComputeStoreConfigError(`unknown abandon cause ${String(input.cause)}`);
    }
    const detail = boundedDetail(input.detail, 2048);
    const result = await this.db.execute<ClaimRow>({
      sql: `UPDATE compute_plane.worker_claims
SET status = 'abandoned', abandoned_at = $2, abandon_cause = $3, abandon_detail = $4::jsonb, updated_at = now()
WHERE id = $1 AND status = 'claimed'
RETURNING *`,
      parameters: [input.claimId, now, input.cause, JSON.stringify(detail)],
    });
    return result.rows.length > 0 ? claimOf(result.rows[0] as ClaimRow) : null;
  }

  async getClaim(claimId: string): Promise<WorkerClaimRecord | null> {
    const result = await this.db.execute<ClaimRow>({
      sql: `SELECT * FROM compute_plane.worker_claims WHERE id = $1`,
      parameters: [claimId],
    });
    return result.rows.length > 0 ? claimOf(result.rows[0] as ClaimRow) : null;
  }

  async listClaimsByExecution(executionId: string): Promise<readonly WorkerClaimRecord[]> {
    const result = await this.db.execute<ClaimRow>({
      sql: `SELECT * FROM compute_plane.worker_claims WHERE execution_id = $1 ORDER BY claim_epoch`,
      parameters: [executionId],
    });
    return result.rows.map((row) => claimOf(row));
  }

  async listLiveClaims(workerId?: string): Promise<readonly WorkerClaimRecord[]> {
    const result = workerId
      ? await this.db.execute<ClaimRow>({
          sql: `SELECT * FROM compute_plane.worker_claims WHERE worker_id = $1 AND status = 'claimed' ORDER BY claimed_at`,
          parameters: [workerId],
        })
      : await this.db.execute<ClaimRow>({
          sql: `SELECT * FROM compute_plane.worker_claims WHERE status = 'claimed' ORDER BY claimed_at`,
          parameters: [],
        });
    return result.rows.map((row) => claimOf(row));
  }

  async listStaleClaims(
    heartbeatOlderThanMs: number,
    limit: number,
  ): Promise<readonly WorkerClaimRecord[]> {
    const result = await this.db.execute<ClaimRow>({
      sql: `SELECT * FROM compute_plane.worker_claims
WHERE status = 'claimed'
  AND (last_heartbeat_at IS NULL OR last_heartbeat_at < (now() - ($1 || ' milliseconds')::interval))
ORDER BY coalesce(last_heartbeat_at, claimed_at)
LIMIT $2`,
      parameters: [heartbeatOlderThanMs, limit],
    });
    return result.rows.map((row) => claimOf(row));
  }

  // -------------------------------------------------------------------- quotas

  async setEnvironmentQuota(
    computeEnvironmentId: string,
    maxConcurrentClaims: number,
  ): Promise<void> {
    if (
      !Number.isInteger(maxConcurrentClaims) ||
      maxConcurrentClaims < WORKER_POLICY_BOUNDS.defaultEnvironmentQuota.min ||
      maxConcurrentClaims > WORKER_POLICY_BOUNDS.defaultEnvironmentQuota.max
    ) {
      throw new ComputeStoreConfigError("environment quota must be bounded [1, 512]");
    }
    await this.db.execute({
      sql: `INSERT INTO compute_plane.environment_quotas (compute_environment_id, application_id, max_concurrent_claims)
SELECT $1, application_id, $2 FROM sandbox.compute_environments WHERE id = $1
ON CONFLICT (compute_environment_id) DO UPDATE SET max_concurrent_claims = $2, updated_at = now()`,
      parameters: [computeEnvironmentId, maxConcurrentClaims],
    });
  }

  async getEnvironmentQuota(
    computeEnvironmentId: string,
  ): Promise<{ readonly quota: number; readonly liveClaims: number } | null> {
    const result = await this.db.execute<{
      readonly max_concurrent_claims: number;
      readonly live_claims: string;
    }>({
      sql: `SELECT q.max_concurrent_claims,
       (SELECT count(*) FROM compute_plane.worker_claims c
        WHERE c.compute_environment_id = q.compute_environment_id AND c.status = 'claimed') AS live_claims
FROM compute_plane.environment_quotas q
WHERE q.compute_environment_id = $1`,
      parameters: [computeEnvironmentId],
    });
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0] as {
      readonly max_concurrent_claims: number;
      readonly live_claims: string;
    };
    return {
      quota: row.max_concurrent_claims,
      liveClaims: Number(row.live_claims),
    };
  }

  // -------------------------------------------------------------------- runners

  async registerRunner(
    input: RunnerRegistrationInput,
    now: string,
  ): Promise<RunnerRegistrationRecord> {
    const metadata = boundedDetail(input.metadata, 2048);
    const result = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute<RunnerRow>({
        sql: `INSERT INTO compute_plane.runner_registrations
(runner_id, application_id, tenant_id, endpoint_url, token_secret_ref, status, registered_by, registered_at, metadata)
VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8::jsonb)
ON CONFLICT (runner_id) DO NOTHING
RETURNING *`,
        parameters: [
          input.runnerId,
          input.applicationId,
          input.tenantId,
          input.endpointUrl,
          input.tokenSecretRef,
          input.registeredBy,
          now,
          JSON.stringify(metadata),
        ],
      });
      if (inserted.rows.length > 0) {
        return inserted.rows[0] as RunnerRow;
      }
      const existing = await tx.execute<RunnerRow>({
        sql: `SELECT * FROM compute_plane.runner_registrations WHERE runner_id = $1`,
        parameters: [input.runnerId],
      });
      return existing.rows[0] ?? null;
    });
    if (result === null) {
      throw new ComputeStoreConfigError("runner registration failed (no row)");
    }
    return runnerOf(result);
  }

  async transitionRunner(
    runnerId: string,
    status: RunnerRegistrationStatus,
    input: { readonly reason?: string; readonly actorId: string; readonly now: string },
  ): Promise<RunnerRegistrationRecord> {
    const reason = input.reason === undefined ? null : input.reason.slice(0, 200);
    const now = input.now;
    const result = await this.db.execute<RunnerRow>({
      sql: `UPDATE compute_plane.runner_registrations
SET status = $2,
    activated_at = CASE WHEN $2 = 'active' AND activated_at IS NULL THEN $3 ELSE activated_at END,
    suspended_at = CASE WHEN $2 = 'suspended' THEN $3 ELSE suspended_at END,
    revoked_at = CASE WHEN $2 = 'revoked' THEN $3 ELSE revoked_at END,
    revocation_reason = CASE WHEN $2 = 'revoked' THEN $4 ELSE revocation_reason END
WHERE runner_id = $1
RETURNING *`,
      parameters: [runnerId, status, now, reason],
    });
    if (result.rows.length === 0) {
      throw new ComputeStoreConfigError(`runner ${runnerId} does not exist`);
    }
    return runnerOf(result.rows[0] as RunnerRow);
  }

  async getRunner(runnerId: string): Promise<RunnerRegistrationRecord | null> {
    const result = await this.db.execute<RunnerRow>({
      sql: `SELECT * FROM compute_plane.runner_registrations WHERE runner_id = $1`,
      parameters: [runnerId],
    });
    return result.rows.length > 0 ? runnerOf(result.rows[0] as RunnerRow) : null;
  }

  async listRunners(applicationId?: string): Promise<readonly RunnerRegistrationRecord[]> {
    const result = applicationId
      ? await this.db.execute<RunnerRow>({
          sql: `SELECT * FROM compute_plane.runner_registrations WHERE application_id = $1 ORDER BY registered_at, runner_id`,
          parameters: [applicationId],
        })
      : await this.db.execute<RunnerRow>({
          sql: `SELECT * FROM compute_plane.runner_registrations ORDER BY registered_at, runner_id`,
          parameters: [],
        });
    return result.rows.map((row) => runnerOf(row));
  }

  async findActiveRunner(
    applicationId: string,
    tenantId: string,
  ): Promise<RunnerRegistrationRecord | null> {
    const result = await this.db.execute<RunnerRow>({
      sql: `SELECT * FROM compute_plane.runner_registrations
WHERE application_id = $1 AND tenant_id = $2 AND status = 'active'
ORDER BY registered_at LIMIT 1`,
      parameters: [applicationId, tenantId],
    });
    return result.rows.length > 0 ? runnerOf(result.rows[0] as RunnerRow) : null;
  }

  // --------------------------------------------------------------- compaction

  async compactTerminalClaims(
    limit: number,
    isTerminalExecution?: (executionId: string) => Promise<boolean>,
  ): Promise<ClaimCompactionReport> {
    // Bounded retained worker metadata: terminal claims older than
    // the retention bound, removed ONLY when the executions authority
    // (the injected module-side seam — the compute plane never reads
    // the executions tables) says the execution is terminal. Without
    // the seam nothing is removed (fail closed: the operator surface
    // must wire the authority check). The physical delete gate
    // rejects anything non-terminal.
    const cutoff = new Date(this.clock().getTime() - this.claimRetentionMs).toISOString();
    const candidates = await this.db.execute<ClaimRow>({
      sql: `SELECT * FROM compute_plane.worker_claims
WHERE status IN ('finished', 'abandoned')
  AND updated_at < $1
ORDER BY updated_at
LIMIT $2`,
      parameters: [cutoff, limit],
    });
    let removed = 0;
    for (const row of candidates.rows) {
      if (isTerminalExecution !== undefined && !(await isTerminalExecution(row.execution_id))) {
        continue;
      }
      const deleted = await this.db.execute({
        sql: `DELETE FROM compute_plane.worker_claims WHERE id = $1 AND status IN ('finished', 'abandoned')`,
        parameters: [row.id],
      });
      removed += deleted.rowCount ?? 0;
    }
    return { inspected: candidates.rows.length, removed };
  }
}

function refused(reason: ClaimRefusalReason): ClaimAcquisitionOutcome {
  return { outcome: "refused", reason };
}
