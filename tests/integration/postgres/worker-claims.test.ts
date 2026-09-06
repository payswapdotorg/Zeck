/**
 * Integration — the compute-plane claim gate + store over REAL
 * PostgreSQL (WORK-046 / D-05; checkpoint contracts
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Proves over the real database:
 *
 *  - claim admission is atomic and typed: per-worker concurrency,
 *    per-environment quota, bounded re-selection attempts, one live
 *    claim per execution (physically), worker-not-active /
 *    worker-unknown refusals;
 *  - the claim lifecycle: lease correlation set exactly once, the
 *    heartbeat ledger is monotonic, terminal states are physically
 *    immutable, the claim epoch is unique per execution;
 *  - a claim for a terminal execution is unrepresentable (FK gate);
 *  - stale sweeps: workers offline by heartbeat age, claims abandoned;
 *  - quotas: the per-environment override, the live-claim count;
 *  - compaction: terminal claims of terminal executions only, the
 *    retention bound honored, live rows never deleted;
 *  - the bounded re-selection budget: attempts-exhausted refused
 *    typed, the bound is exact.
 */

import { expect, test } from "vitest";
import { SqlComputeWorkerStore } from "../../../src/platform/compute/pg-store";
import { definePgSuite } from "./harness";
import { generateId, seedWorkerFabricWorld } from "./worker-world";

definePgSuite("worker claim gate + compute-plane store (WORK-046 D-05)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  test("claim admission: a fresh worker admits a claim with epoch 1", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("admit-basic");
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    const outcome = await w.store.acquireClaim(
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
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome === "admitted") {
      expect(outcome.claim.claimEpoch).toBe(1);
      expect(outcome.claim.status).toBe("claimed");
      expect(outcome.claim.leaseOwner).toBeNull();
    }
  });

  test("one live claim per execution: a second concurrent claim is refused typed", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("one-live");
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    const input = {
      workerId,
      executionId,
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      environmentId: w.environmentId,
      computeEnvironmentId: w.containerEnvironmentId,
    };
    const first = await w.store.acquireClaim(input, new Date().toISOString());
    expect(first.outcome).toBe("admitted");
    const second = await w.store.acquireClaim(input, new Date().toISOString());
    expect(second.outcome).toBe("refused");
    if (second.outcome === "refused") {
      expect(second.reason.kind).toBe("duplicate-live-claim");
    }
  });

  test("per-worker concurrency: the declared bound refuses typed", async () => {
    const w = await world();
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 1 },
      new Date().toISOString(),
    );
    const executionIds = [
      await w.createDispatchedExecution("conc-1"),
      await w.createDispatchedExecution("conc-2"),
    ];
    const first = await w.store.acquireClaim(
      {
        workerId,
        executionId: executionIds[0] as string,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      new Date().toISOString(),
    );
    expect(first.outcome).toBe("admitted");
    const second = await w.store.acquireClaim(
      {
        workerId,
        executionId: executionIds[1] as string,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      new Date().toISOString(),
    );
    expect(second.outcome).toBe("refused");
    if (second.outcome === "refused") {
      expect(second.reason.kind).toBe("worker-concurrency-saturated");
    }
  });

  test("per-environment quota: the default quota refuses typed; the override applies", async () => {
    const w = await world();
    // The default quota from the world policy is 8 — configure it down.
    const quotaStore = w.store;
    await quotaStore.setEnvironmentQuota(w.containerEnvironmentId, 1);
    const workerA = generateId();
    const workerB = generateId();
    for (const workerId of [workerA, workerB]) {
      await w.store.registerWorker(
        { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
        new Date().toISOString(),
      );
    }
    const executionIds = [
      await w.createDispatchedExecution("quota-1"),
      await w.createDispatchedExecution("quota-2"),
    ];
    const base = {
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      environmentId: w.environmentId,
      computeEnvironmentId: w.containerEnvironmentId,
    };
    const first = await w.store.acquireClaim(
      { ...base, workerId: workerA, executionId: executionIds[0] as string },
      new Date().toISOString(),
    );
    expect(first.outcome).toBe("admitted");
    const second = await w.store.acquireClaim(
      { ...base, workerId: workerB, executionId: executionIds[1] as string },
      new Date().toISOString(),
    );
    expect(second.outcome).toBe("refused");
    if (second.outcome === "refused") {
      expect(second.reason.kind).toBe("quota-saturated");
      expect(second.reason).toMatchObject({ quota: 1, liveClaims: 1 });
    }
    const observed = await quotaStore.getEnvironmentQuota(w.containerEnvironmentId);
    expect(observed).toMatchObject({ quota: 1, liveClaims: 1 });
  });

  test("a claim cannot be bypassed by another worker instance: the physical one-live-claim index", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("physical-one");
    const workerA = generateId();
    const workerB = generateId();
    for (const workerId of [workerA, workerB]) {
      await w.store.registerWorker(
        { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
        new Date().toISOString(),
      );
    }
    const base = {
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      environmentId: w.environmentId,
      computeEnvironmentId: w.containerEnvironmentId,
      executionId,
    };
    const first = await w.store.acquireClaim(
      { ...base, workerId: workerA },
      new Date().toISOString(),
    );
    expect(first.outcome).toBe("admitted");
    // A racing claim from another worker converges to the typed refusal.
    const second = await w.store.acquireClaim(
      { ...base, workerId: workerB },
      new Date().toISOString(),
    );
    expect(second.outcome).toBe("refused");
    // The physical schema rejects a second live row outright.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO compute_plane.worker_claims
(id, execution_id, application_id, tenant_id, compute_environment_id, worker_id, claim_epoch, claimed_at)
VALUES ($1, $2, $3, $4, $5, $6, 2, now())`,
        parameters: [
          generateId(),
          executionId,
          w.applicationId,
          w.tenantId,
          w.containerEnvironmentId,
          workerB,
        ],
      }),
    ).rejects.toThrow(/one_live_claim_per_execution/);
  });

  test("bounded re-selection: the claim-attempt budget refuses typed and exact", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("budget");
    const base = {
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      environmentId: w.environmentId,
      computeEnvironmentId: w.containerEnvironmentId,
      executionId,
    };
    // maxClaimAttempts = 3 (the world policy): three claims, each
    // abandoned, then the fourth is refused attempts-exhausted.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const workerId = generateId();
      await w.store.registerWorker(
        { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
        new Date().toISOString(),
      );
      const outcome = await w.store.acquireClaim({ ...base, workerId }, new Date().toISOString());
      expect(outcome.outcome).toBe("admitted");
      if (outcome.outcome === "admitted") {
        expect(outcome.claim.claimEpoch).toBe(attempt);
        await w.store.abandonClaim(
          { claimId: outcome.claim.id, cause: "worker-lost", detail: { attempt } },
          new Date().toISOString(),
        );
      }
    }
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    const refused = await w.store.acquireClaim({ ...base, workerId }, new Date().toISOString());
    expect(refused.outcome).toBe("refused");
    if (refused.outcome === "refused") {
      expect(refused.reason.kind).toBe("attempts-exhausted");
      expect(refused.reason).toMatchObject({ attempts: 3, bound: 3 });
    }
  });

  test("draining and offline workers admit nothing", async () => {
    const w = await world();
    const draining = generateId();
    const offline = generateId();
    const now = new Date().toISOString();
    await w.store.registerWorker(
      {
        workerId: draining,
        applicationId: w.applicationId,
        kind: "first-party",
        declaredConcurrency: 4,
      },
      now,
    );
    await w.store.registerWorker(
      {
        workerId: offline,
        applicationId: w.applicationId,
        kind: "first-party",
        declaredConcurrency: 4,
      },
      now,
    );
    await w.store.beginDrain(draining, now);
    await w.store.retireWorker(offline, "test-retire", now);
    const executionId = await w.createDispatchedExecution("drain-offline");
    for (const workerId of [draining, offline]) {
      const outcome = await w.store.acquireClaim(
        {
          workerId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: w.containerEnvironmentId,
        },
        now,
      );
      expect(outcome.outcome).toBe("refused");
      if (outcome.outcome === "refused") {
        expect(outcome.reason.kind).toBe("worker-not-active");
      }
    }
    const unknown = await w.store.acquireClaim(
      {
        workerId: generateId(),
        executionId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      now,
    );
    expect(unknown.outcome).toBe("refused");
    if (unknown.outcome === "refused") {
      expect(unknown.reason.kind).toBe("worker-unknown");
    }
  });

  test("a claim for a terminal execution is unrepresentable (the FK admission gate)", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("terminal-fk");
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start" },
      `start-term-${executionId}`,
    );
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "fail" },
      `fail-term-${executionId}`,
    );
    await expect(
      w.store.acquireClaim(
        {
          workerId,
          executionId,
          applicationId: w.applicationId,
          tenantId: w.tenantId,
          environmentId: w.environmentId,
          computeEnvironmentId: w.containerEnvironmentId,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/terminal; no worker claim may be admitted/);
  });

  test("the lease correlation is set exactly once; the heartbeat ledger is monotonic", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("lease-once");
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    const outcome = await w.store.acquireClaim(
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
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome !== "admitted") {
      return;
    }
    const claim = outcome.claim;
    const correlated = await w.store.recordClaimLease(claim.id, {
      leaseOwner: workerId,
      leaseEpoch: 1,
    });
    expect(correlated?.leaseOwner).toBe(workerId);
    expect(correlated?.leaseEpoch).toBe(1);
    // A rewrite of the correlation is refused (returns null).
    const rewrite = await w.store.recordClaimLease(claim.id, {
      leaseOwner: "someone-else",
      leaseEpoch: 2,
    });
    expect(rewrite).toBeNull();
    // Heartbeats advance the monotonic ledger.
    const first = await w.store.heartbeatClaim(claim.id, new Date().toISOString());
    const second = await w.store.heartbeatClaim(claim.id, new Date().toISOString());
    expect(first?.heartbeatCount).toBe(1);
    expect(second?.heartbeatCount).toBe(2);
    // The physical rewrite of the lease correlation is rejected.
    await expect(
      ctx.port.execute({
        sql: `UPDATE compute_plane.worker_claims SET lease_owner = $2, lease_epoch = $3 WHERE id = $1`,
        parameters: [claim.id, "attacker", 99],
      }),
    ).rejects.toThrow(/lease correlation is set once/);
  });

  test("terminal claims are physically immutable; live rows are never deleted", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("immutable");
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    const outcome = await w.store.acquireClaim(
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
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome !== "admitted") {
      return;
    }
    const claimId = outcome.claim.id;
    // Live rows are never deleted.
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM compute_plane.worker_claims WHERE id = $1",
        parameters: [claimId],
      }),
    ).rejects.toThrow(/live rows are never deleted/);
    const finished = await w.store.completeClaim(
      { claimId, outcome: "applied-success", outcomeDetail: { ok: true } },
      new Date().toISOString(),
    );
    expect(finished?.status).toBe("finished");
    // Terminal rows are immutable.
    await expect(
      ctx.port.execute({
        sql: "UPDATE compute_plane.worker_claims SET outcome = 'applied-failure' WHERE id = $1",
        parameters: [claimId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
  });

  test("stale sweeps: offline workers and abandoned claims are typed and inspectable", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("sweep");
    const workerId = generateId();
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      staleAt,
    );
    const outcome = await w.store.acquireClaim(
      {
        workerId,
        executionId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        environmentId: w.environmentId,
        computeEnvironmentId: w.containerEnvironmentId,
      },
      staleAt,
    );
    expect(outcome.outcome).toBe("admitted");
    const swept = await w.store.sweepStaleWorkers(1_000, new Date().toISOString());
    expect(swept.map((record) => record.workerId)).toContain(workerId);
    const worker = await w.store.getWorker(workerId);
    expect(worker?.status).toBe("offline");
    expect(worker?.offlineReason).toBe("heartbeat-age-exceeded");
    // The stale claim is listed by heartbeat age and abandoned typed.
    const staleClaims = await w.store.listStaleClaims(1_000, 10);
    expect(staleClaims.map((claim) => claim.id)).toContain(
      outcome.outcome === "admitted" ? outcome.claim.id : "",
    );
    if (outcome.outcome === "admitted") {
      const abandoned = await w.store.abandonClaim(
        { claimId: outcome.claim.id, cause: "heartbeat-lost", detail: { swept: true } },
        new Date().toISOString(),
      );
      expect(abandoned?.status).toBe("abandoned");
      expect(abandoned?.abandonCause).toBe("heartbeat-lost");
    }
  });

  test("compaction: terminal claims of terminal executions only, retention honored", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("compact");
    const workerId = generateId();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 4 },
      new Date().toISOString(),
    );
    const outcome = await w.store.acquireClaim(
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
    expect(outcome.outcome).toBe("admitted");
    if (outcome.outcome !== "admitted") {
      return;
    }
    await w.store.completeClaim(
      { claimId: outcome.claim.id, outcome: "applied-success", outcomeDetail: {} },
      new Date().toISOString(),
    );
    // The terminal-execution seam (the executions AUTHORITY decides;
    // the compute plane never reads the executions tables).
    const isTerminalExecution = async (executionId: string): Promise<boolean> => {
      const execution = await w.service.getExecution(w.applicationId, executionId);
      return (
        execution !== null &&
        ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)
      );
    };

    // The execution is still RUNNING: compaction keeps the claim.
    const kept = await w.store.compactTerminalClaims(10, isTerminalExecution);
    expect(kept.removed).toBe(0);
    // Without the authority seam: nothing is removed (fail closed).
    const seamLess = await w.store.compactTerminalClaims(10);
    expect(seamLess.removed).toBe(0);
    // Drive the execution terminal.
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "start" },
      `start-comp-${executionId}`,
    );
    await w.service.transition(
      { ...w.scopeOf(executionId), command: "fail" },
      `fail-comp-${executionId}`,
    );
    // Still within retention: nothing removed.
    const fresh = await w.store.compactTerminalClaims(10, isTerminalExecution);
    expect(fresh.removed).toBe(0);
    // Beyond retention (the store clock passes the retention cutoff):
    // terminal rows are physically immutable, so time — not row
    // mutation — drives compaction.
    const futureStore = new SqlComputeWorkerStore({
      db: ctx.port,
      maxClaimAttempts: 3,
      defaultEnvironmentQuota: 8,
      claimRetentionMs: 3_600_000,
      generateId,
      now: () => new Date(Date.now() + 40 * 24 * 3_600_000),
    });
    const compacted = await futureStore.compactTerminalClaims(10, isTerminalExecution);
    expect(compacted.removed).toBe(1);
    expect(await w.store.getClaim(outcome.claim.id)).toBeNull();
  });

  test("worker registration: identity core immutable, offline terminal, heartbeats monotonic", async () => {
    const w = await world();
    const workerId = generateId();
    const now = new Date().toISOString();
    await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 2 },
      now,
    );
    // Idempotent re-registration replays the durable row.
    const replay = await w.store.registerWorker(
      { workerId, applicationId: w.applicationId, kind: "first-party", declaredConcurrency: 2 },
      now,
    );
    expect(replay.workerId).toBe(workerId);
    expect(replay.status).toBe("active");
    const heartbeat = await w.store.heartbeatWorker(workerId, new Date().toISOString());
    expect(heartbeat?.heartbeatCount).toBe(1);
    // The identity core is physically immutable.
    await expect(
      ctx.port.execute({
        sql: "UPDATE compute_plane.worker_registrations SET declared_concurrency = 99 WHERE worker_id = $1",
        parameters: [workerId],
      }),
    ).rejects.toThrow(/identity core is immutable/);
    await w.store.retireWorker(workerId, "done", new Date().toISOString());
    // Offline is terminal: re-activation is unrepresentable.
    await expect(
      ctx.port.execute({
        sql: "UPDATE compute_plane.worker_registrations SET status = 'active' WHERE worker_id = $1",
        parameters: [workerId],
      }),
    ).rejects.toThrow(/terminal-immutable in offline/);
  });

  test("customer-runner workers: governed binding, application scope, revocation", async () => {
    const w = await world();
    const runnerId = generateId();
    const runner = await w.store.registerRunner(
      {
        runnerId,
        applicationId: w.applicationId,
        tenantId: w.tenantId,
        endpointUrl: "https://runner.customer.example",
        tokenSecretRef: `zeck-secret://local/runner-${runnerId.slice(-6)}`,
        registeredBy: "operator-test",
      },
      new Date().toISOString(),
    );
    expect(runner.status).toBe("pending");
    // A pending runner cannot bind a worker.
    const workerId = generateId();
    await expect(
      w.store.registerWorker(
        {
          workerId,
          applicationId: w.applicationId,
          kind: "customer-runner",
          runnerId,
          declaredConcurrency: 2,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/only active runners may register workers/);
    await w.store.transitionRunner(runnerId, "active", {
      actorId: "operator-test",
      now: new Date().toISOString(),
    });
    const bound = await w.store.registerWorker(
      {
        workerId,
        applicationId: w.applicationId,
        kind: "customer-runner",
        runnerId,
        declaredConcurrency: 2,
      },
      new Date().toISOString(),
    );
    expect(bound.status).toBe("active");
    // The binding is scoped: claims of ANOTHER application's executions
    // are refused physically.
    const otherTenant = generateId();
    const otherApp = generateId();
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [otherTenant, `t-${otherTenant.slice(-6)}`, "other tenant"],
    });
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [otherApp, otherTenant, `a-${otherApp.slice(-6)}`, "other app"],
    });
    // A compute environment registered under the OTHER application (the
    // physical FK discipline holds; the scope gate then fires).
    const otherEnvironmentId = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO sandbox.compute_environments (id, application_id, tenant_id, slug, name, kind, spec, spec_digest, status, created_at, updated_at)
VALUES ($1, $2, $3, 'other-env', 'Other Env', 'container', '{}'::jsonb, 'd', 'available', now(), now())`,
      parameters: [otherEnvironmentId, otherApp, otherTenant],
    });
    const otherExecution = await ctx.port
      .execute<{ id: string }>({
        sql: `INSERT INTO executions.executions (id, application_id, tenant_id, task, request_fingerprint, last_event_sequence)
VALUES ($1, $2, $3, '{}'::jsonb, 'other', 1) RETURNING id`,
        parameters: [generateId(), otherApp, otherTenant],
      })
      .then((result) => result.rows[0]?.id as string);
    await expect(
      w.store.acquireClaim(
        {
          workerId,
          executionId: otherExecution,
          applicationId: otherApp,
          tenantId: otherTenant,
          environmentId: w.environmentId,
          computeEnvironmentId: otherEnvironmentId,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/may only claim executions of its own application/);
    // The runner lifecycle: suspend -> activate -> revoke (terminal).
    await w.store.transitionRunner(runnerId, "suspended", {
      actorId: "operator-test",
      now: new Date().toISOString(),
    });
    await w.store.transitionRunner(runnerId, "active", {
      actorId: "operator-test",
      now: new Date().toISOString(),
    });
    const revoked = await w.store.transitionRunner(runnerId, "revoked", {
      actorId: "operator-test",
      reason: "test-revocation",
      now: new Date().toISOString(),
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.revocationReason).toBe("test-revocation");
    // A fresh worker can no longer bind the revoked runner.
    await expect(
      w.store.registerWorker(
        {
          workerId: generateId(),
          applicationId: w.applicationId,
          kind: "customer-runner",
          runnerId,
          declaredConcurrency: 2,
        },
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/only active runners may register workers/);
    // Registration identity is immutable (endpoint/secret never move).
    await expect(
      ctx.port.execute({
        sql: "UPDATE compute_plane.runner_registrations SET endpoint_url = 'https://evil.example' WHERE runner_id = $1",
        parameters: [runnerId],
      }),
    ).rejects.toThrow(/registration identity is immutable/);
  });
});
