/**
 * Regional worker evacuation, drain and fencing (platform recovery
 * plane; WORK-048 / D-07, acceptance criterion 4: "Regional worker
 * evacuation drains or fences active work and allows restartable
 * reassignment without stale-worker mutation").
 *
 * THE MODEL (authority stays where it always was):
 *
 *  - Worker registrations are EXECUTOR coordination rows in the
 *    durable compute plane; a region label is bounded reference-only
 *    registration metadata (`metadata.region`), never domain state.
 *  - Evacuation NEVER mutates execution state: it moves worker-plane
 *    coordination (retire registrations, abandon claims with typed
 *    causes) and fences the DURABLE EXECUTION LEASES the evacuated
 *    workers hold, so a late (stale) worker write fails the lease
 *    fence at the authoritative boundary (`lease-released`).
 *  - Restartable reassignment is the EXISTING recovery convergence:
 *    the executions authority re-drives the abandoned executions on
 *    a fresh claim with a fresh lease epoch (a different region's
 *    worker, or a new worker anywhere). No provider-local state, no
 *    worker-local state, no reconstruction.
 *
 * MODES (the honest operational distinction):
 *
 *  - `drain` (PLANNED evacuation — provider exit, maintenance): the
 *    region's active workers first move to `draining` (claim
 *    admission refuses draining workers by construction), then the
 *    straggler claims abandon with the existing `worker-drained`
 *    cause, then the identities retire `offline`, then their leases
 *    release. Workers that observe drain in time finish gracefully
 *    (the fabric's own bounded drain path).
 *  - `fence` (REGIONAL LOSS — the region is gone, no cooperation):
 *    retire the identities first (terminal `offline`), abandon the
 *    live claims with the existing `worker-lost` cause, then force-
 *    release every live lease those claims held — IMMEDIATE fencing:
 *    the stale worker's next write hits the `lease-released` fence
 *    without waiting for lease TTL expiry.
 *
 * Everything is bounded, typed and auditable; the report is evidence,
 * never authority.
 */

import type {
  ComputeWorkerStore,
  WorkerClaimRecord,
  WorkerRegistrationRecord,
} from "../compute/port";

/**
 * The lease force-release seam (implemented by the executions module
 * over its single lease system — the only new seam D-07 needs, the
 * minimal existing-seam consumption the packet allows).
 */
export interface LeaseEvacuationSeam {
  /**
   * Force-release the live lease of one execution (bounded cause).
   * Returns `released: true` iff a live lease existed and was
   * released; `false` when no live lease existed (idempotent).
   */
  forceRelease(input: {
    readonly applicationId: string;
    readonly executionId: string;
    readonly cause: string;
  }): Promise<{ readonly released: boolean }>;
}

/** Fail-closed evacuation configuration error. */
export class EvacuationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvacuationConfigError";
  }
}

export type EvacuationMode = "drain" | "fence";

export interface EvacuatedClaim {
  readonly claimId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly cause: "worker-drained" | "worker-lost";
  readonly leaseReleased: boolean;
}

export interface EvacuationReport {
  readonly region: string;
  readonly mode: EvacuationMode;
  /** Workers selected by the region label (active/draining at start). */
  readonly selectedWorkers: readonly string[];
  /** Workers moved to draining first (drain mode only). */
  readonly drainingWorkers: readonly string[];
  /** Workers retired offline (terminal identities, never resurrected). */
  readonly retiredWorkers: readonly string[];
  /** Live claims abandoned (recoverable — re-drive converges them). */
  readonly abandonedClaims: readonly EvacuatedClaim[];
  /**
   * Workers still active in OTHER regions after the evacuation (the
   * restartable-reassignment capacity evidence).
   */
  readonly remainingActiveWorkers: readonly string[];
  /** True iff the evacuation procedure completed without error. */
  readonly completed: boolean;
}

export interface EvacuationDeps {
  readonly store: ComputeWorkerStore;
  readonly lease: LeaseEvacuationSeam;
  readonly now: () => Date;
}

const MAX_REGION_LENGTH = 100;
const MAX_CAUSE_LENGTH = 100;
const DRAIN_CAUSE = "worker-drained";
const LOSS_CAUSE = "worker-lost";
const EVACUATION_RELEASE_CAUSE = "regional-evacuation";

/** The bounded region label of a worker registration (null when absent). */
export function regionOf(worker: WorkerRegistrationRecord): string | null {
  const metadata = worker.metadata as Record<string, unknown> | null;
  const region = metadata?.region;
  return typeof region === "string" && region.length > 0 ? region : null;
}

/**
 * The regional evacuation controller. One instance per composition
 * root; `evacuate` is idempotent-safe to re-run (already-offline
 * workers select out; abandoned claims are no longer live).
 */
export class RegionalWorkerEvacuator {
  private readonly deps: EvacuationDeps;

  constructor(deps: EvacuationDeps) {
    this.deps = deps;
  }

  /**
   * Evacuate one region. `drain` requests graceful order (drain →
   * abandon → retire → release); `fence` retires first (uncooperative
   * regional loss). Both end with every evacuated live claim abandoned
   * and every live lease force-released (immediate stale fencing).
   */
  async evacuate(input: {
    readonly region: string;
    readonly mode: EvacuationMode;
  }): Promise<EvacuationReport> {
    if (input.region.length === 0 || input.region.length > MAX_REGION_LENGTH) {
      throw new EvacuationConfigError(
        `region label must be 1..${MAX_REGION_LENGTH} characters (bounded metadata)`,
      );
    }
    const now = this.deps.now().toISOString();
    const cause = input.mode === "drain" ? DRAIN_CAUSE : LOSS_CAUSE;

    // 1. Select the region's worker identities (bounded scan).
    const workers = await this.deps.store.listWorkers();
    const ofRegion = workers.filter((worker) => regionOf(worker) === input.region);
    if (ofRegion.length === 0) {
      // Fail closed: a region with NO worker at all (not even retired
      // ones) is ambiguous input (wrong label) — never a silent no-op
      // success.
      throw new EvacuationConfigError(
        `no workers are registered for region "${input.region}" (fail closed: verify the region label)`,
      );
    }
    const selected = ofRegion.filter((worker) => worker.status !== "offline");
    if (selected.length === 0) {
      // Idempotent re-run: the region's identities are ALL already
      // offline (terminal) — the evacuated state is already the
      // durable truth; report the bounded no-op.
      const after = await this.deps.store.listWorkers();
      return Object.freeze({
        region: input.region,
        mode: input.mode,
        selectedWorkers: Object.freeze([] as string[]),
        drainingWorkers: Object.freeze([] as string[]),
        retiredWorkers: Object.freeze([] as string[]),
        abandonedClaims: Object.freeze([] as EvacuatedClaim[]),
        remainingActiveWorkers: Object.freeze(
          after
            .filter((worker) => worker.status === "active" && regionOf(worker) !== input.region)
            .map((worker) => worker.workerId),
        ),
        completed: true,
      });
    }

    // 2. Drain mode: request drain first so still-running fabric loops
    //    observe it (claim admission refuses draining workers).
    const drainingWorkers: string[] = [];
    if (input.mode === "drain") {
      for (const worker of selected) {
        if (worker.status === "active") {
          const drained = await this.deps.store.beginDrain(worker.workerId, now);
          if (drained !== null) {
            drainingWorkers.push(worker.workerId);
          }
        }
      }
    }

    // 3. Fence mode retires identities FIRST (the region is gone; no
    //    cooperation is possible or expected).
    const retiredWorkers: string[] = [];
    if (input.mode === "fence") {
      for (const worker of selected) {
        const retired = await this.deps.store.retireWorker(
          worker.workerId,
          `${EVACUATION_RELEASE_CAUSE}:${input.region}`.slice(
            0,
            MAX_CAUSE_LENGTH + MAX_REGION_LENGTH,
          ),
          now,
        );
        if (retired !== null) {
          retiredWorkers.push(worker.workerId);
        }
      }
    }

    // 4. Abandon the region's live claims and release their leases.
    //    (After a drain-mode step 2, claim admission already refuses;
    //    the live claims at evacuation time are the stragglers.)
    const abandonedClaims: EvacuatedClaim[] = [];
    const workerIds = new Set(selected.map((worker) => worker.workerId));
    for (const worker of selected) {
      const liveClaims = await this.deps.store.listLiveClaims(worker.workerId);
      for (const claim of liveClaims) {
        await this.abandonAndRelease(claim, cause, now);
        abandonedClaims.push({
          claimId: claim.id,
          executionId: claim.executionId,
          applicationId: claim.applicationId,
          cause,
          leaseReleased: claim.leaseOwner !== null,
        });
      }
    }

    // 5. Drain mode retires the identities after the stragglers are
    //    abandoned (terminal; restart registers a NEW identity).
    if (input.mode === "drain") {
      for (const worker of selected) {
        const retired = await this.deps.store.retireWorker(
          worker.workerId,
          `${EVACUATION_RELEASE_CAUSE}:${input.region}`.slice(
            0,
            MAX_CAUSE_LENGTH + MAX_REGION_LENGTH,
          ),
          now,
        );
        if (retired !== null) {
          retiredWorkers.push(worker.workerId);
        }
      }
    }

    // 6. The restartable-reassignment capacity evidence: workers that
    //    remain active in other regions.
    const after = await this.deps.store.listWorkers();
    const remainingActiveWorkers = after
      .filter((worker) => worker.status === "active" && !workerIds.has(worker.workerId))
      .map((worker) => worker.workerId);

    return Object.freeze({
      region: input.region,
      mode: input.mode,
      selectedWorkers: Object.freeze([...selected.map((worker) => worker.workerId)]),
      drainingWorkers: Object.freeze([...drainingWorkers]),
      retiredWorkers: Object.freeze([...retiredWorkers]),
      abandonedClaims: Object.freeze([...abandonedClaims]),
      remainingActiveWorkers: Object.freeze([...remainingActiveWorkers]),
      completed: true,
    });
  }

  /** Abandon one claim and force-release its live lease (the fence). */
  private async abandonAndRelease(
    claim: WorkerClaimRecord,
    cause: "worker-drained" | "worker-lost",
    now: string,
  ): Promise<void> {
    if (claim.leaseOwner !== null) {
      // The fence: release the live lease the stale worker holds so
      // its NEXT write fails the authoritative lease guard. Idempotent
      // (a released lease stays released).
      await this.deps.lease.forceRelease({
        applicationId: claim.applicationId,
        executionId: claim.executionId,
        cause: EVACUATION_RELEASE_CAUSE,
      });
    }
    await this.deps.store.abandonClaim(
      {
        claimId: claim.id,
        cause,
        detail: {
          evacuatedAt: now,
          fence: claim.leaseOwner !== null ? "lease-released" : "no-lease",
        },
      },
      now,
    );
  }
}
