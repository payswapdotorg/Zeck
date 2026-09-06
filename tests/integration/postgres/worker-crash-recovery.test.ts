/**
 * Integration — the worker crash matrix over REAL PostgreSQL
 * (WORK-046 / D-05; acceptance criteria 2, 3, 4, 5; checkpoint
 * contract CONCURRENCY-CRASH-SAFETY — the deterministic matrix the
 * Work Order requires).
 *
 * THE MATRIX (each step durable, each crash simulated by NOT
 * continuing the interrupted worker's chain — the WORK-024/045
 * convention; no in-process promise is ever left pending):
 *
 *   C1  crash before lease persistence      — claim admitted, no lease;
 *        the recovery scan re-drives (fresh claim, fresh lease epoch).
 *   C2  crash after lease persistence but before provider dispatch —
 *        stale claim (heartbeat age) + expired lease; the sweep
 *        abandons typed, the recovery re-drives.
 *   C3  crash during provider call — the sandbox row is left
 *        `dispatching` (the honest unknown-effect state): re-selection
 *        fails closed (NON_CONVERGENT), the bounded attempts exhaust,
 *        the execution fails through the authority (never re-executed,
 *        never silently dropped).
 *   C4  provider call succeeds then worker crashes before the
 *        completion write — the terminal sandbox outcome replays
 *        through the deterministic sandbox identity: exactly ONE
 *        provider dispatch ever, the execution completes through a
 *        fresh claim (no duplicate governed effect).
 *   C5  completion write races lease expiry — the stale worker is
 *        FENCED at the authoritative boundary (its completion NEVER
 *        lands), the claim abandons stale-write, the recovery re-drives
 *        and converges (one provider dispatch total).
 *   C6  heartbeat loss and stale-worker replacement — the sweep
 *        offlines the worker and abandons its claim; the recovery
 *        re-drives on a fresh claim/lease epoch.
 *   C7  cancellation racing provider completion — the governed cancel
 *        wins: the worker's post-work convergence classifies terminal
 *        (converged-elsewhere); the worker NEVER overrides the
 *        authoritative cancellation.
 *   C8  two workers racing the same execution — the physical
 *        one-live-claim index arbitrates; the loser re-delivers
 *        bounded.
 *   C9  worker drain racing new dispatch — draining stops acquisition;
 *        the straggler claim is abandoned recoverable; the fresh
 *        worker converges it.
 *   C10 restart after partial in-flight execution — the recovery scan
 *        alone (no queue involvement) re-drives everything from the
 *        executions authority.
 */

import { expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { generateId, seedWorkerFabricWorld, WORKER_ACTOR_ID } from "./worker-world";

definePgSuite("worker crash matrix (WORK-046 D-05)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  /**
   * Drive one execution's governed start + claim (+ lease) directly —
   * the "interrupted worker" durable state at the named stage (the
   * fabric's own sequence: start -> claim -> lease -> settle -> work).
   */
  const interruptAfter = async (
    w: Awaited<ReturnType<typeof world>>,
    executionId: string,
    stage: "claim" | "lease",
  ) => {
    // The governed start (QUEUED -> RUNNING) — the same single write
    // path the fabric's start effect drives.
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start", reason: "queue-transport-delivery" },
      `queue-consume:execution-dispatch:${executionId}`,
    );
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
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
      throw new Error(`interruptAfter: claim not admitted (${JSON.stringify(claim)})`);
    }
    if (stage === "claim") {
      return { workerId, claim: claim.claim, lease: null };
    }
    const lease = await w.lease.acquire({
      applicationId: w.applicationId,
      executionId,
      tenantId: w.tenantId,
      ownerId: workerId,
      ttlMs: stage === "lease" ? 50 : w.policy.leaseTtlMs,
      reason: "interrupted-worker",
    });
    if (lease.outcome !== "acquired") {
      throw new Error(`interruptAfter: lease not acquired (${JSON.stringify(lease)})`);
    }
    await w.store.recordClaimLease(claim.claim.id, {
      leaseOwner: lease.claim.ownerId,
      leaseEpoch: lease.claim.epoch,
    });
    return { workerId, claim: claim.claim, lease: lease.claim };
  };

  /**
   * Age a claim's heartbeat past the stale bound and let a
   * short-TTL lease expire naturally (the lease guard trigger rightly
   * rejects expiry shortening — time, not row mutation, drives expiry).
   */
  const agePastBounds = async (
    w: Awaited<ReturnType<typeof world>>,
    claimId: string,
    _executionId: string,
  ) => {
    void w;
    await ctx.port.execute({
      sql: `UPDATE compute_plane.worker_claims
SET last_heartbeat_at = now() - interval '10 minutes'
WHERE id = $1`,
      parameters: [claimId],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  };

  test("C1 crash before lease persistence: the recovery re-drives on a fresh claim", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c1");
    const interrupted = await interruptAfter(w, executionId, "claim");

    // The claim is live — the recovery skips it (one live claim per
    // execution); nothing is duplicated.
    const fabric = await w.createFabric();
    const first = await fabric.recover();
    expect(first.skippedLiveClaim).toBe(1);
    expect(w.provider.dispatchCount()).toBe(0);

    // The interrupted worker dies (its claim goes stale): the sweep
    // abandons it typed, the recovery re-drives.
    await agePastBounds(w, interrupted.claim.id, executionId);
    const second = await fabric.recover();
    expect(second.abandonedClaims).toBe(1);
    expect(second.claimed).toBe(1);
    expect(second.applied).toBe(1);

    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
    const claims = await w.store.listClaimsByExecution(executionId);
    expect(claims).toHaveLength(2);
    expect(claims.at(0)?.abandonCause).toBe("heartbeat-lost");
    expect(claims.at(1)?.outcome).toBe("applied-success");
    expect(w.provider.dispatchCount()).toBe(1);
  });

  test("C2 crash after lease persistence before dispatch: sweep + re-drive, new lease epoch", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c2");
    const interrupted = await interruptAfter(w, executionId, "lease");
    expect(interrupted.lease?.epoch).toBe(1);
    await agePastBounds(w, interrupted.claim.id, executionId);

    const fabric = await w.createFabric();
    const recovery = await fabric.recover();
    expect(recovery.abandonedClaims).toBe(1);
    expect(recovery.claimed).toBe(1);
    expect(recovery.applied).toBe(1);

    // The fresh worker's lease is a NEW epoch — the stale worker's
    // (owner, epoch) pair can never match again.
    const lease = await w.lease.inspect(w.applicationId, executionId);
    expect(lease?.epoch).toBe(2);
    expect(lease?.ownerId).not.toBe(interrupted.workerId);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
    expect(w.provider.dispatchCount()).toBe(1);
  });

  test("C3 crash during provider call: the honest unknown-effect barrier, bounded exhaustion, governed failure", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c3");
    const interrupted = await interruptAfter(w, executionId, "lease");

    // The crashed-mid-dispatch durable state: the sandbox row is left
    // `dispatching` (claimed for dispatch, outcome unknown). The
    // interrupted worker's executor used the STABLE service actor and
    // the EXACT task the fabric's executor would extract — the sandbox
    // identity fingerprint converges across process restarts.
    const sandboxKey = `worker-exec:${executionId}`;
    const task = w.taskFor("cmd-c3");
    const sandboxBlock = (task.sandbox ?? {}) as {
      command: string;
      args: string[];
      publicEnv: Record<string, string>;
    };
    const created = await w.sandboxService.createSandboxExecution(
      {
        executionId,
        environmentId: w.containerEnvironmentId,
        task: {
          command: sandboxBlock.command,
          args: [...sandboxBlock.args],
          publicEnv: { ...sandboxBlock.publicEnv },
        },
      },
      sandboxKey,
      {
        actorId: WORKER_ACTOR_ID,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
      },
    );
    await ctx.port.execute({
      sql: `UPDATE sandbox.sandbox_executions
SET status = 'dispatching', dispatched_at = now() WHERE id = $1`,
      parameters: [created.id],
    });
    await agePastBounds(w, interrupted.claim.id, executionId);

    // Re-selection fails closed: a prior dispatch left an unknown
    // external outcome — the work refuses to re-execute. Bounded
    // attempts exhaust; the execution fails through the authority.
    // Short lease TTL: each round's lease expires before the next.
    const fabric = await w.createFabric({ policy: { leaseTtlMs: 50 } });
    const first = await fabric.recover();
    expect(first.claimed).toBe(1);
    expect(first.applied).toBe(0);

    // Age the fresh claim stale; repeat until the claim budget (3)
    // exhausts and the governed failure lands.
    for (let round = 0; round < 3; round += 1) {
      const live = await w.store.listLiveClaims();
      for (const claim of live) {
        await ctx.port.execute({
          sql: `UPDATE compute_plane.worker_claims
SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`,
          parameters: [claim.id],
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      await fabric.recover();
    }
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("FAILED");
    // The provider NEVER re-executed (the unknown-outcome barrier).
    expect(w.provider.dispatchCount()).toBe(0);
  });

  test("C4 provider success then crash before the completion write: the terminal sandbox replays; ONE dispatch ever", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c4");

    // Worker 1: claim + lease + the provider dispatch SUCCEEDS (the
    // sandbox row is terminal with the recorded outcome) — but the
    // completion write never happens (the "crash").
    const first = await w.createFabric({
      policy: { leaseTtlMs: 1_500, heartbeatIntervalMs: 60_000 },
    });
    w.provider.blockNextFor(1, 2_000);
    const report = await first.consumeBatch();
    expect(report.executed).toBe(1);
    expect(report.fenced).toBe(1); // the lease elapsed during the work — FENCED, not applied

    // The fenced claim was abandoned; the execution is still RUNNING
    // with a terminal sandbox execution recorded durably.
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");

    // Worker 2's recovery: fresh claim + fresh lease epoch, the
    // terminal sandbox REPLAYS its recorded outcome (no second provider
    // dispatch), the completion lands through the governed path.
    const second = await w.createFabric();
    const recovery = await second.recover();
    expect(recovery.claimed).toBe(1);
    expect(recovery.applied).toBe(1);

    const final = await w.service.getExecution(w.applicationId, executionId);
    expect(final?.status).toBe("COMPLETED");
    expect(final?.verificationRefs.length).toBeGreaterThanOrEqual(1);
    // EXACTLY ONE provider dispatch — the durable sandbox identity
    // converged the re-selection.
    expect(w.provider.dispatchCount()).toBe(1);
  });

  test("C5 completion racing lease expiry: the stale worker is fenced at the authority", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c5");

    // Worker 1: short lease, work longer than the lease, no renewal
    // cadence during the work — the completion fence fires.
    const fabric = await w.createFabric({
      policy: { leaseTtlMs: 1_000, heartbeatIntervalMs: 60_000 },
    });
    w.provider.blockNextFor(1, 2_000);
    const report = await fabric.consumeBatch();
    expect(report.executed).toBe(1);
    expect(report.fenced).toBe(1);
    expect(report.applied).toBe(0);

    // The stale worker's completion NEVER became authoritative.
    let execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");

    // The fenced claim is durably classified: abandoned with the
    // stale-write cause (inspectable, honest — never silent).
    const claims = await w.store.listClaimsByExecution(executionId);
    expect(claims.at(0)?.status).toBe("abandoned");
    expect(claims.at(0)?.abandonCause).toBe("stale-write");

    // The fresh worker converges (one dispatch total).
    const fresh = await w.createFabric();
    const recovery = await fresh.recover();
    expect(recovery.applied).toBe(1);
    execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
    expect(w.provider.dispatchCount()).toBe(1);
  });

  test("C6 heartbeat loss and stale-worker replacement: sweep + re-drive", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c6");
    const interrupted = await interruptAfter(w, executionId, "lease");

    // The worker's registration goes stale (heartbeat age) and its
    // claim with it.
    await ctx.port.execute({
      sql: `UPDATE compute_plane.worker_registrations
SET last_heartbeat_at = now() - interval '10 minutes' WHERE worker_id = $1`,
      parameters: [interrupted.workerId],
    });
    await agePastBounds(w, interrupted.claim.id, executionId);

    const fabric = await w.createFabric();
    const recovery = await fabric.recover();
    expect(recovery.sweptWorkers).toBeGreaterThanOrEqual(1);
    expect(recovery.abandonedClaims).toBeGreaterThanOrEqual(1);
    expect(recovery.applied).toBe(1);

    const worker = await w.store.getWorker(interrupted.workerId);
    expect(worker?.status).toBe("offline");
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
  });

  test("C7 cancellation racing provider completion: the governed cancel wins", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c7");
    const fabric = await w.createFabric();

    // The work runs (bounded); DURING the provider call the governed
    // cancellation lands through the authority (deterministic: wait
    // until the provider call has STARTED before cancelling).
    w.provider.blockNextFor(1, 1_500);
    const run = fabric.consumeBatch();
    const deadline = Date.now() + 5_000;
    while (w.provider.dispatchCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(w.provider.dispatchCount()).toBe(1);
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "cancel" },
      `cancel-c7-${executionId}`,
    );
    const report = await run;

    // The cancellation was NEVER overridden by the worker's completion
    // (no verify/pass, no applied claim). Two honest convergence
    // classes exist under this race, both worker-non-override:
    //  - the post-work observation converges (converged-elsewhere); or
    //  - the sandbox ledger's terminal discipline refuses the
    //    post-completion evidence append (governed work-refusal).
    expect(report.applied).toBe(0);
    expect(report.converged + report.workRefusals).toBeGreaterThanOrEqual(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("CANCELLED");
    const claims = await w.store.listClaimsByExecution(executionId);
    expect(claims.at(0)?.outcome).not.toBe("applied-success");
    expect(["converged-elsewhere", null]).toContain(claims.at(0)?.outcome ?? null);
    // The worker never drove the completion transitions.
    const kinds = (await w.eventsOf(executionId)).map((event) => event.kind);
    expect(kinds).not.toContain("execution.verify");
    expect(kinds).not.toContain("execution.pass");
  });

  test("C8 two workers racing the same execution: the physical index arbitrates", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c8");
    const winner = await interruptAfter(w, executionId, "lease");

    // The loser fabric pulls the delivery: the claim gate refuses
    // (one live claim per execution) — bounded re-delivery.
    const loser = await w.createFabric();
    const report = await loser.consumeBatch();
    expect(report.claimRefusals.some((refusal) => refusal.kind === "quota-saturated")).toBe(false);
    expect(report.transientRetried).toBe(1);
    expect(report.claimed).toBe(0);
    expect(w.provider.dispatchCount()).toBe(0);

    // The winner finishes its work (simulated through the recovery of a
    // fresh worker after the winner's claim goes stale).
    await agePastBounds(w, winner.claim.id, executionId);
    const fabric = await w.createFabric();
    const recovery = await fabric.recover();
    expect(recovery.applied).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
  });

  test("C9 worker drain racing new dispatch: draining stops acquisition, stragglers recoverable", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("c9");
    const fabric = await w.createFabric();
    await fabric.register();

    // The fabric's own live claim (the governed start + admission
    // through the store — the straggler a bounded drain abandons).
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start", reason: "queue-transport-delivery" },
      `queue-consume:execution-dispatch:${executionId}`,
    );
    const straggler = await w.store.acquireClaim(
      {
        workerId: fabric.worker?.workerId as string,
        executionId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      new Date().toISOString(),
    );
    expect(straggler.outcome).toBe("admitted");

    // Drain: new acquisition stops (empty report), the straggler is
    // abandoned recoverable, the identity retires offline.
    const workerId = fabric.worker?.workerId as string;
    await fabric.stop("test-drain");
    const drainedPull = await fabric.consumeBatch();
    expect(drainedPull.pulled).toBe(0);

    if (straggler.outcome === "admitted") {
      const claim = await w.store.getClaim(straggler.claim.id);
      expect(claim?.status).toBe("abandoned");
      expect(claim?.abandonCause).toBe("worker-drained");
    }
    const worker = await w.store.getWorker(workerId);
    expect(worker?.status).toBe("offline");

    // A fresh worker converges the abandoned work (never lost).
    const fresh = await w.createFabric();
    const recovery = await fresh.recover();
    expect(recovery.applied).toBe(1);
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
  });

  test("C10 restart after partial in-flight execution: the recovery scan alone converges", async () => {
    const w = await world();
    const executionIds = [
      await w.createDispatchedExecution("c10-a"),
      await w.createDispatchedExecution("c10-b"),
    ];
    // Both executions: interrupted after the claim (in-flight, then
    // the process died).
    const interrupted = [] as { workerId: string; claimId: string }[];
    for (const executionId of executionIds) {
      const state = await interruptAfter(w, executionId, "claim");
      interrupted.push({ workerId: state.workerId, claimId: state.claim.id });
      await agePastBounds(w, state.claim.id, executionId);
    }

    // A FRESH worker (the "restart") converges both from the
    // executions authority — no queue involvement (the envelopes are
    // still published; the recovery never touches the transport).
    const fabric = await w.createFabric();
    const recovery = await fabric.recover();
    expect(recovery.candidates).toBe(2);
    expect(recovery.abandonedClaims).toBe(2);
    expect(recovery.claimed).toBe(2);
    expect(recovery.applied).toBe(2);

    for (const executionId of executionIds) {
      const execution = await w.service.getExecution(w.applicationId, executionId);
      expect(execution?.status).toBe("COMPLETED");
    }
    expect(w.provider.dispatchCount()).toBe(2);
    // The transport was never pulled by the recovery.
    expect(w.transport.eventLog().every((event) => event.kind !== "pull" || event.at === 1)).toBe(
      true,
    );
  });
});
