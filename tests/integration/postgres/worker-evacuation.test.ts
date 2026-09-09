/**
 * Integration — regional worker evacuation, drain and fencing over
 * REAL PostgreSQL (WORK-048 / D-07, acceptance criterion 4; checkpoint
 * contracts CONCURRENCY-CRASH-SAFETY, AUTH-PRESERVATION).
 *
 * THE DRILL MATRIX (each row is the durable story of one evacuation;
 * the interrupted-worker convention is the WORK-046 C-matrix's — the
 * durable state of a worker that stopped mid-chain, driven through
 * the REAL governed path):
 *
 *   E1 FENCE (regional loss): a region's workers hold live claims and
 *      leases on in-flight executions; the region is LOST (no
 *      cooperation). Evacuation retires the identities, abandons the
 *      claims (`worker-lost`) and FORCE-RELEASES the live leases — the
 *      stale workers are IMMEDIATELY fenced (no lease-TTL wait).
 *   E2 STALE-WRITE FENCING (the discrimination core): after the
 *      evacuation, the stale region-A worker's completion attempt is
 *      refused at the durable lease guard (`lease-released`) — NO
 *      authoritative mutation lands (the guard the completion effect
 *      consults before every write).
 *   E3 RESTARTABLE REASSIGNMENT: a fresh worker in another region
 *      recovers the abandoned executions (the fabric recovery scan —
 *      durable-state-driven, no queue involvement) and converges them
 *      with EXACTLY ONE provider dispatch per execution.
 *   E4 DRAIN (planned evacuation): drain mode moves active workers to
 *      `draining` first, then abandons the straggler claims
 *      `worker-drained` and retires the identities offline.
 *   E5 REGION SELECTIVITY: only the target region's workers are
 *      evacuated; other regions' workers stay active.
 *   E6 IDEMPOTENT EVACUATION: re-running the evacuation selects
 *      nothing (identities are offline-terminal) and is a bounded
 *      no-op; an unknown region label fails closed.
 */

import { expect, test } from "vitest";
import { createLeaseEvacuationSeam } from "../../../src/modules/executions/adapters/evacuation-seam";
import { SqlLongRunningExecutionStore } from "../../../src/modules/executions/adapters/sql-long-running-store";
import { RegionalWorkerEvacuator } from "../../../src/platform/recovery/evacuation";
import { definePgSuite } from "./harness";
import { generateId, seedWorkerFabricWorld, type WorkerFabricWorld } from "./worker-world";

definePgSuite("regional worker evacuation, drain and fencing (WORK-048 D-07)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  /** The evacuator over the world's real durable stores. */
  const evacuatorFor = (w: WorkerFabricWorld): RegionalWorkerEvacuator =>
    new RegionalWorkerEvacuator({
      store: w.store,
      lease: createLeaseEvacuationSeam(new SqlLongRunningExecutionStore(w.db)),
      now: () => new Date(),
    });

  /**
   * The interrupted region-A worker's durable state: governed start +
   * live claim + live lease, provider NOT yet dispatched (the exact
   * state an evacuated region leaves behind — the WORK-046
   * interruptAfter convention, region-labeled).
   */
  const interruptedRegionWorker = async (
    w: WorkerFabricWorld,
    executionId: string,
    region: string,
  ) => {
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start", reason: "queue-transport-delivery" },
      `queue-consume:execution-dispatch:${executionId}`,
    );
    const workerId = generateId();
    await w.store.registerWorker(
      {
        workerId,
        applicationId: w.applicationId,
        kind: "first-party",
        declaredConcurrency: 4,
        metadata: { region },
      },
      new Date().toISOString(),
    );
    const claim = await w.store.acquireClaim(
      {
        workerId,
        executionId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      new Date().toISOString(),
    );
    if (claim.outcome !== "admitted") {
      throw new Error(`claim not admitted (${JSON.stringify(claim)})`);
    }
    const lease = await w.lease.acquire({
      applicationId: w.applicationId,
      executionId,
      tenantId: w.tenantId,
      ownerId: workerId,
      ttlMs: 60_000,
      reason: "interrupted-region-worker",
    });
    if (lease.outcome !== "acquired") {
      throw new Error(`lease not acquired (${JSON.stringify(lease)})`);
    }
    await w.store.recordClaimLease(claim.claim.id, {
      leaseOwner: lease.claim.ownerId,
      leaseEpoch: lease.claim.epoch,
    });
    return { workerId, claim: claim.claim, lease: lease.claim };
  };

  test("E1+E2+E3 fence: evacuate the lost region, fence the stale worker, reassign and converge exactly once", async () => {
    const w = await world();
    const regionB = await w.createFabric({ metadata: { region: "region-b-e1" } });
    const evacuator = evacuatorFor(w);

    // Two executions, each with an interrupted region-A worker holding
    // a live claim + live lease (the region is about to be lost).
    const executionOne = await w.createDispatchedExecution("evac-1");
    const executionTwo = await w.createDispatchedExecution("evac-2");
    const staleOne = await interruptedRegionWorker(w, executionOne, "region-a-e1");
    const staleTwo = await interruptedRegionWorker(w, executionTwo, "region-a-e1");
    expect(staleOne.lease.epoch).toBe(1);

    // THE REGION IS LOST: evacuate region-a-e1 in fence mode.
    const evacuation = await evacuator.evacuate({ region: "region-a-e1", mode: "fence" });
    expect(evacuation.mode).toBe("fence");
    expect([...evacuation.selectedWorkers].sort()).toEqual(
      [staleOne.workerId, staleTwo.workerId].sort(),
    );
    expect(evacuation.retiredWorkers).toHaveLength(2);
    expect(evacuation.abandonedClaims).toHaveLength(2);
    expect(new Set(evacuation.abandonedClaims.map((claim) => claim.cause))).toEqual(
      new Set(["worker-lost"]),
    );
    expect(evacuation.remainingActiveWorkers).toContain(regionB.worker?.workerId);

    // The abandoned claims are recoverable rows, not live claims.
    expect(await w.liveClaimOf(executionOne)).toBeNull();
    expect(await w.liveClaimOf(executionTwo)).toBeNull();

    // E2 — the stale region-A workers are IMMEDIATELY fenced: their
    // (owner, epoch) pairs fail the durable lease guard (this is the
    // exact guard the completion effect consults before any write).
    for (const stale of [staleOne, staleTwo]) {
      const guard = await w.lease.guard(
        w.applicationId,
        stale.claim.executionId,
        stale.claim.leaseOwner === null
          ? { ownerId: stale.workerId, epoch: stale.claim.claimEpoch }
          : { ownerId: stale.claim.leaseOwner, epoch: stale.claim.leaseEpoch as number },
      );
      expect(guard).not.toBeNull();
      expect(guard?.fenceClass).toBe("lease-released");
      // The stale renewal is refused too (typed stale outcome).
      const renewal = await w.lease.renew({
        applicationId: w.applicationId,
        executionId: stale.claim.executionId,
        tenantId: w.tenantId,
        claim: {
          ownerId: stale.claim.leaseOwner as string,
          epoch: stale.claim.leaseEpoch as number,
        },
        ttlMs: 5_000,
        renewalOrdinal: (stale.claim.heartbeatCount ?? 0) + 1,
      });
      expect(renewal.outcome).toBe("stale");
    }

    // The lease records prove the force release (auditable cause).
    const leaseStore = new SqlLongRunningExecutionStore(w.db);
    for (const executionId of [executionOne, executionTwo]) {
      const lease = await leaseStore.getLease(w.applicationId, executionId);
      expect(lease?.releasedAt).not.toBeNull();
    }

    // E3 — restartable reassignment: region-B's worker recovers the
    // abandoned executions from the authority (no queue involvement).
    const recovery = await regionB.recover();
    expect(recovery.claimed).toBe(2);
    expect(recovery.applied + recovery.converged).toBe(2);

    // EXACTLY ONE provider dispatch per execution (2 total).
    expect(w.provider.dispatchCount()).toBe(2);

    // The executions COMPLETED through the authority (fresh lease
    // epochs — the stale pairs can never match again).
    for (const executionId of [executionOne, executionTwo]) {
      const execution = await w.service.getExecution(w.applicationId, executionId);
      expect(execution?.status).toBe("COMPLETED");
      const lease = await w.lease.inspect(w.applicationId, executionId);
      expect(lease?.epoch).toBeGreaterThan(1);
    }

    await regionB.stop("test-complete");
  });

  test("E4 drain: planned evacuation drains first, abandons stragglers worker-drained, retires offline", async () => {
    const w = await world();
    const regionB = await w.createFabric({ metadata: { region: "region-b-e4" } });
    const evacuator = evacuatorFor(w);

    const executionId = await w.createDispatchedExecution("evac-drain");
    const stale = await interruptedRegionWorker(w, executionId, "region-a-e4");

    // Planned evacuation (drain mode): draining first, then the
    // straggler abandonment with the worker-drained cause.
    const evacuation = await evacuator.evacuate({ region: "region-a-e4", mode: "drain" });
    expect(evacuation.mode).toBe("drain");
    expect(evacuation.drainingWorkers).toEqual([stale.workerId]);
    expect(evacuation.retiredWorkers).toEqual([stale.workerId]);
    expect(evacuation.abandonedClaims.map((claim) => claim.cause)).toEqual(["worker-drained"]);

    // The worker identity is terminal offline; the claim is recoverable.
    const worker = await w.store.getWorker(stale.workerId);
    expect(worker?.status).toBe("offline");
    expect(worker?.offlineReason).toContain("regional-evacuation:region-a-e4");
    expect((await w.store.listClaimsByExecution(executionId)).at(0)?.abandonCause).toBe(
      "worker-drained",
    );

    // A fresh worker in another region converges the straggler.
    const recovery = await regionB.recover();
    expect(recovery.claimed).toBe(1);
    expect(w.provider.dispatchCount()).toBe(1);
    await regionB.stop("test-complete");
  });

  test("E5 region selectivity: only the target region is evacuated", async () => {
    const w = await world();
    const regionA = await w.createFabric({ metadata: { region: "region-a-e5" } });
    const regionC = await w.createFabric({ metadata: { region: "region-c-e5" } });
    const evacuator = evacuatorFor(w);

    const evacuation = await evacuator.evacuate({ region: "region-c-e5", mode: "fence" });
    expect(evacuation.selectedWorkers).toEqual([regionC.worker?.workerId]);
    expect(evacuation.remainingActiveWorkers).toContain(regionA.worker?.workerId);

    const a = await w.store.getWorker(regionA.worker?.workerId as string);
    expect(a?.status).toBe("active");
  });

  test("E6 idempotent evacuation: a re-run selects nothing; unknown regions fail closed", async () => {
    const w = await world();
    const regionA = await w.createFabric({ metadata: { region: "region-a-e6" } });
    const evacuator = evacuatorFor(w);

    const first = await evacuator.evacuate({ region: "region-a-e6", mode: "fence" });
    expect(first.selectedWorkers).toHaveLength(1);
    const second = await evacuator.evacuate({ region: "region-a-e6", mode: "fence" });
    expect(second.selectedWorkers).toHaveLength(0);
    expect(second.abandonedClaims).toHaveLength(0);
    expect(second.completed).toBe(true);

    // An unknown region label is a fail-closed error (the operator
    // asked to evacuate a region that does not exist — ambiguous
    // input, never a silent no-op PASS).
    await expect(evacuator.evacuate({ region: "nowhere", mode: "fence" })).rejects.toThrow(
      /no workers are registered for region "nowhere"/,
    );
  });
});
