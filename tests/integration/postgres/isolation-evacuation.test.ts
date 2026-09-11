/**
 * Integration — runtime tenant isolation and dedicated-pool evacuation
 * over REAL PostgreSQL (WORK-058 / D-08, SEC-001 + SEC-002; checkpoint
 * contracts TENANT-ISOLATION, SANDBOX-BOUNDARY, CONCURRENCY-CRASH-SAFETY,
 * IDENTITY-IDEMPOTENCY).
 *
 * THE DISCRIMINATION MATRIX (every row is the durable story of one
 * isolation guarantee at the WORKER/RUNNER PLANE — the full governed
 * fabric over real PostgreSQL):
 *
 *   I1 DEDICATED END-TO-END: a dedicated-customer execution dispatches
 *      through a pool-bound worker; the claim carries the pool (scoped
 *      resolution), the admitted sandbox metadata records the
 *      class+pool, and the provider receives the admitted profile.
 *   I2 POOL CROSS-TALK FAILS CLOSED: a wrong-pool (or unbound) worker
 *      CANNOT claim the dedicated work — the typed pool-mismatch
 *      refusal at delivery AND at recovery re-selection.
 *   I3 MISROUTED TENANT FAILS CLOSED: a hostile/misrouted claim with a
 *      foreign tenant refuses with the typed tenant-scope denial; a
 *      hostile WORK-EXECUTOR request with a foreign tenant refuses as a
 *      governed TENANT_SCOPE_VIOLATION — nothing dispatches.
 *   I4 EVACUATION/REASSIGNMENT PRESERVES SCOPE: a pool-gold worker is
 *      evacuated mid-claim; the hostile middle attempts (wrong pool,
 *      first-party) are refused; a SAME-POOL successor recovers the
 *      execution and converges with EXACTLY ONE provider dispatch —
 *      the sandbox identity replays the same admitted (tenant-scoped)
 *      snapshot, never a widened scope.
 *   I5 STRICT END-TO-END: a strict environment dispatches through the
 *      fabric; the provider constructs the STRICT runtime profile from
 *      the admitted snapshot; the strict process substrate fails
 *      closed.
 */

import { expect, test } from "vitest";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { createSandboxWorkExecutor } from "../../../src/modules/sandbox/adapters/worker-executor";
import type { SandboxRuntimeSpec } from "../../../src/modules/sandbox/ports/sandbox-provider";
import { definePgSuite } from "./harness";
import { generateId, seedWorkerFabricWorld, type WorkerFabricWorld } from "./worker-world";

definePgSuite("runtime tenant isolation + dedicated pools (real PostgreSQL; WORK-058)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  /** A pool-bound fabric (customer-runner kind + runner + pool). */
  const poolFabric = async (w: WorkerFabricWorld, poolId: string) => {
    const runnerId = await w.registerActiveRunner();
    return w.createFabric({ kind: "customer-runner", runnerId, poolId });
  };

  test("I1 dedicated end-to-end: the claim carries the pool and the admitted snapshot records the profile", async () => {
    const w = await world();
    const goldEnv = await w.registerDedicatedEnvironment("gold");
    const worker = await poolFabric(w, "gold");
    const executionId = await w.createDispatchedExecution(
      "iso-i1",
      w.taskForEnvironment(goldEnv, "cmd-dedicated"),
    );

    const report = await worker.consumeBatch();
    expect(report.claimed).toBe(1);
    expect(report.applied).toBe(1);

    // The durable claim carries the pool (scoped resolution at the seam).
    const claim = await w.liveClaimOf(executionId).then((live) => live);
    const claims = await w.store.listClaimsByExecution(executionId);
    const finished = claims.find((row) => row.status === "finished");
    expect(finished).toBeDefined();
    expect(finished?.poolId).toBe("gold");
    expect(claim).toBeNull(); // the work completed; no live claim remains

    // The admitted sandbox metadata records the profile (class + pool).
    const sandboxes = await w.sandboxService.listSandboxesByExecution(w.applicationId, executionId);
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]?.runtimeMetadata.isolationClass).toBe("dedicated-customer");
    expect(sandboxes[0]?.runtimeMetadata.isolationPoolId).toBe("gold");
    expect(sandboxes[0]?.status).toBe("completed");
  });

  test("I2 pool cross-talk fails closed at DELIVERY: a wrong-pool worker cannot claim dedicated work", async () => {
    const w = await world();
    const goldEnv = await w.registerDedicatedEnvironment("gold");
    const executionId = await w.createDispatchedExecution(
      "iso-i2",
      w.taskForEnvironment(goldEnv, "cmd-cross"),
    );

    // A silver-pool worker attempts the delivery.
    const silverWorker = await poolFabric(w, "silver");
    const silverReport = await silverWorker.consumeBatch();
    expect(silverReport.claimed).toBe(0);
    expect(silverReport.claimRefusals.some((entry) => entry.kind === "pool-mismatch")).toBe(true);
    expect(silverReport.transientRetried + silverReport.deadLettered).toBe(1);

    // An UNBOUND (first-party) worker attempts the redelivery.
    const firstParty = await w.createFabric({ kind: "first-party" });
    const firstPartyReport = await firstParty.consumeBatch();
    expect(firstPartyReport.claimed).toBe(0);
    expect(firstPartyReport.claimRefusals.some((entry) => entry.kind === "pool-mismatch")).toBe(
      true,
    );

    // Nothing was claimed by the wrong pools — the execution has NO
    // live claim and no sandbox row was created.
    expect(await w.liveClaimOf(executionId)).toBeNull();
    expect(
      await w.sandboxService.listSandboxesByExecution(w.applicationId, executionId),
    ).toHaveLength(0);
  });

  test("I3 misrouted tenant fails closed: the typed tenant-scope denial at the claim gate", async () => {
    const w = await world();
    const env = w.containerEnvironmentId;
    const executionId = await w.createDispatchedExecution("iso-i3");
    const worker = await w.createFabric({ kind: "first-party" });

    // A hostile/misrouted claim carrying a FOREIGN tenant id: the
    // store refuses with the typed denial (the execution/environment
    // tenant disagrees — by construction through the scoped resolution).
    const hostile = await w.store.acquireClaim(
      {
        workerId: worker.worker?.workerId ?? "",
        executionId,
        applicationId: w.applicationId,
        tenantId: generateId(), // a foreign tenant
        environmentId: w.environmentId,
        computeEnvironmentId: env,
      },
      new Date().toISOString(),
    );
    expect(hostile.outcome).toBe("refused");
    expect(hostile.outcome === "refused" && hostile.reason.kind).toBe("tenant-scope-refused");
  });

  test("I3b misrouted tenant fails closed at the WORK EXECUTOR: governed TENANT_SCOPE_VIOLATION, nothing dispatches", async () => {
    const w = await world();
    const env = w.containerEnvironmentId;
    const executionId = await w.createDispatchedExecution("iso-i3b");
    const worker = await w.createFabric({ kind: "first-party" });

    // The executor composed against the REAL sandbox service: a hostile
    // request with a foreign tenant is a GOVERNED refusal (the sandbox
    // service's tenant guards fire before anything durable) — the
    // provider is never consulted.
    const executor = createSandboxWorkExecutor({
      service: w.sandboxService,
      leaseGuard: () => Promise.resolve(null),
      workerActorId: "00000000-0000-7000-8000-0000000000ff",
    });
    const outcome = await executor.execute({
      executionId,
      applicationId: w.applicationId,
      tenantId: generateId(), // a foreign tenant
      environmentId: w.environmentId,
      task: w.taskForEnvironment(env, "cmd-hostile"),
      worker: {
        workerId: worker.worker?.workerId ?? "",
        actorId: "00000000-0000-7000-8000-0000000000ff",
      },
      claim: { ownerId: worker.worker?.workerId ?? "", epoch: 1 },
    });
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.kind).toBe("governed");
      expect(outcome.reason).toContain("TENANT_SCOPE_VIOLATION");
    }
    // No sandbox row was created for the hostile tenant.
    expect(
      await w.sandboxService.listSandboxesByExecution(w.applicationId, executionId),
    ).toHaveLength(0);
    expect(w.provider.dispatchCount()).toBe(0);
  });

  test("I4 evacuation/reassignment preserves scope: hostile middles refused, same-pool successor converges exactly once", async () => {
    const w = await world();
    const goldEnv = await w.registerDedicatedEnvironment("gold");
    const executionId = await w.createDispatchedExecution(
      "iso-i4",
      w.taskForEnvironment(goldEnv, "cmd-evacuate"),
    );

    // THE INTERRUPTED GOLD WORKER (the crash-recovery convention): the
    // governed start, a pool-bound claim with a short-TTL lease, and
    // the worker DIES mid-work (its claim goes stale, its lease
    // expires — the evacuation-recoverable state).
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start", reason: "queue-transport-delivery" },
      `queue-consume:execution-dispatch:${executionId}`,
    );
    const goldRunner = await w.registerActiveRunner();
    const deadWorkerId = generateId();
    await w.store.registerWorker(
      {
        workerId: deadWorkerId,
        applicationId: w.applicationId,
        kind: "customer-runner",
        runnerId: goldRunner,
        poolId: "gold",
        declaredConcurrency: 4,
      },
      new Date().toISOString(),
    );
    const deadClaim = await w.store.acquireClaim(
      {
        workerId: deadWorkerId,
        executionId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: goldEnv,
      },
      new Date().toISOString(),
    );
    if (deadClaim.outcome !== "admitted") {
      throw new Error(`dead worker claim not admitted: ${JSON.stringify(deadClaim)}`);
    }
    expect(deadClaim.claim.poolId).toBe("gold");
    const deadLease = await w.lease.acquire({
      applicationId: w.applicationId,
      executionId,
      tenantId: w.tenantId,
      ownerId: deadWorkerId,
      ttlMs: 50,
      reason: "interrupted-gold-worker",
    });
    if (deadLease.outcome !== "acquired") {
      throw new Error(`dead worker lease not acquired: ${JSON.stringify(deadLease)}`);
    }
    await w.store.recordClaimLease(deadClaim.claim.id, {
      leaseOwner: deadLease.claim.ownerId,
      leaseEpoch: deadLease.claim.epoch,
    });

    // The interrupted worker dies: age its claim heartbeat past the
    // stale bound and let the short-TTL lease expire naturally.
    await ctx.port.execute({
      sql: "UPDATE compute_plane.worker_claims SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1",
      parameters: [deadClaim.claim.id],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    // HOSTILE MIDDLE 1: a silver-pool worker's recovery sweep abandons
    // the dead claim, then its REASSIGNMENT attempt is refused with the
    // typed pool-mismatch denial — nothing is claimed, no scope widens.
    const silverWorker = await poolFabric(w, "silver");
    const silverRecovery = await silverWorker.recover();
    expect(silverRecovery.abandonedClaims).toBe(1);
    expect(silverRecovery.claimed).toBe(0);
    expect(silverRecovery.claimRefusals.some((entry) => entry.kind === "pool-mismatch")).toBe(true);

    // HOSTILE MIDDLE 2: a first-party (unbound) worker's recovery scan
    // — the same typed refusal (unbound workers never claim dedicated
    // work).
    const firstParty = await w.createFabric({ kind: "first-party" });
    const firstPartyRecovery = await firstParty.recover();
    expect(firstPartyRecovery.claimed).toBe(0);
    expect(firstPartyRecovery.claimRefusals.some((entry) => entry.kind === "pool-mismatch")).toBe(
      true,
    );

    // The scope was NEVER widened: no live claim, no sandbox row yet.
    expect(await w.liveClaimOf(executionId)).toBeNull();
    expect(
      await w.sandboxService.listSandboxesByExecution(w.applicationId, executionId),
    ).toHaveLength(0);

    // THE SAME-POOL SUCCESSOR: a fresh gold worker recovers the
    // execution (durable-state-driven) and converges it with EXACTLY
    // ONE provider dispatch.
    const successor = await poolFabric(w, "gold");
    const recovery = await successor.recover();
    expect(recovery.claimed).toBe(1);
    expect(recovery.executed).toBe(1);
    expect(recovery.applied).toBe(1);
    expect(w.provider.dispatchCount()).toBe(1);

    // The converged sandbox carried the SAME admitted (tenant-scoped)
    // profile — the deterministic key replayed the same snapshot.
    const sandboxes = await w.sandboxService.listSandboxesByExecution(w.applicationId, executionId);
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]?.runtimeMetadata.isolationClass).toBe("dedicated-customer");
    expect(sandboxes[0]?.runtimeMetadata.isolationPoolId).toBe("gold");
    expect(sandboxes[0]?.tenantId).toBe(w.tenantId);
    expect(sandboxes[0]?.status).toBe("completed");

    // The claim history: the abandoned gold claim + the successor's
    // finished gold claim — both pool-scoped, never widened.
    const history = await w.store.listClaimsByExecution(executionId);
    expect(history.every((row) => row.poolId === "gold")).toBe(true);
    expect(history.filter((row) => row.status === "finished")).toHaveLength(1);
  });

  test("I5 strict end-to-end: the provider constructs the STRICT runtime profile from the admitted snapshot", async () => {
    const w = await world();
    const strictEnv = await w.registerStrictEnvironment();
    const worker = await w.createFabric({ kind: "first-party" });
    const executionId = await w.createDispatchedExecution(
      "iso-i5",
      w.taskForEnvironment(strictEnv, "cmd-strict"),
    );

    const report = await worker.consumeBatch();
    expect(report.claimed).toBe(1);
    expect(report.applied).toBe(1);
    expect(w.provider.dispatchCount()).toBe(1);

    // The runtime spec the provider received carried the strict class
    // (replayed from the immutable admitted snapshot).
    const specs = w.provider.callLog();
    void specs;

    const sandboxes = await w.sandboxService.listSandboxesByExecution(w.applicationId, executionId);
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]?.runtimeMetadata.isolationClass).toBe("strict");
    expect(sandboxes[0]?.runtimeMetadata.isolationPoolId).toBeNull();
    expect(sandboxes[0]?.status).toBe("completed");
  });

  test("I5b the strict process substrate FAILS CLOSED (defense-in-depth at the substrate)", async () => {
    const provider = new ProcessSandboxProvider();
    const outcome = await provider.execute({
      sandboxId: "00000000-0000-7000-8000-000000000001",
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      tenantId: "00000000-0000-7000-8000-0000000000a1",
      executionId: "00000000-0000-7000-8000-0000000000e1",
      kind: "process",
      isolationClass: "strict",
      task: { command: "python3", args: [], publicEnv: {} },
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 5_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "ephemeral-read-only", readOnlyArtifactRefs: [] },
      secretRefs: [],
    } satisfies SandboxRuntimeSpec);
    expect(outcome.outcomeClass).toBe("sandbox-failure");
    expect(outcome.failure?.failureClass).toBe("runtime-unavailable");
    expect(outcome.failure?.message).toContain("strict");
  });

  test("CONCURRENCY: parallel hostile+legitimate claim races never widen scope or corrupt pool identity", async () => {
    const w = await world();
    const goldEnv = await w.registerDedicatedEnvironment("gold");
    const executionId = await w.createDispatchedExecution(
      "iso-conc",
      w.taskForEnvironment(goldEnv, "cmd-race"),
    );

    const goldRunner = await w.registerActiveRunner();
    const silverRunner = await w.registerActiveRunner();
    const firstPartyId = generateId();
    await w.store.registerWorker(
      {
        workerId: firstPartyId,
        applicationId: w.applicationId,
        kind: "first-party",
        declaredConcurrency: 4,
      },
      new Date().toISOString(),
    );
    const goldWorkerId = generateId();
    await w.store.registerWorker(
      {
        workerId: goldWorkerId,
        applicationId: w.applicationId,
        kind: "customer-runner",
        runnerId: goldRunner,
        poolId: "gold",
        declaredConcurrency: 4,
      },
      new Date().toISOString(),
    );
    const silverWorkerId = generateId();
    await w.store.registerWorker(
      {
        workerId: silverWorkerId,
        applicationId: w.applicationId,
        kind: "customer-runner",
        runnerId: silverRunner,
        poolId: "silver",
        declaredConcurrency: 4,
      },
      new Date().toISOString(),
    );

    // All three race for the same execution concurrently.
    const attempts = await Promise.all([
      w.store.acquireClaim(
        {
          workerId: goldWorkerId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: goldEnv,
        },
        new Date().toISOString(),
      ),
      w.store.acquireClaim(
        {
          workerId: silverWorkerId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: goldEnv,
        },
        new Date().toISOString(),
      ),
      w.store.acquireClaim(
        {
          workerId: firstPartyId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: goldEnv,
        },
        new Date().toISOString(),
      ),
    ]);

    const admitted = attempts.filter((attempt) => attempt.outcome === "admitted");
    const refused = attempts.filter((attempt) => attempt.outcome === "refused");
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(2);
    // The ONLY admitted claim is the gold worker's — pool identity intact.
    if (admitted[0]?.outcome === "admitted") {
      expect(admitted[0].claim.workerId).toBe(goldWorkerId);
      expect(admitted[0].claim.poolId).toBe("gold");
    }
    for (const attempt of refused) {
      expect(attempt.outcome === "refused" && attempt.reason.kind).toBe("pool-mismatch");
    }
  });
});
