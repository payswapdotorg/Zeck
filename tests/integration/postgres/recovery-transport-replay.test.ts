/**
 * Integration — THE QUEUE/WORKFLOW REPLAY DRILL (WORK-048 / D-07,
 * acceptance criterion 3: "Queue/workflow messages can be replayed
 * after transport/orchestration loss without duplicating durable
 * authoritative effects").
 *
 * THE MODEL UNDER TEST (D1.0 §10 / D-03/D-04, unchanged): queue
 * messages are POINTERS; the durable dispatch envelope in PostgreSQL
 * is the intent record; workflow instances are provider mechanisms;
 * the durable wait records are the orchestration truth. Losing the
 * providers loses NO authority — replay converges through the
 * EXISTING dispatch/execution idempotency (deterministic correlation
 * keys, the single execution write path), never provider-side dedup.
 *
 * THE DRILL:
 *
 *   R1 TOTAL TRANSPORT LOSS: executions in flight (start + claim +
 *      lease held by a worker that then dies with its region's
 *      transport); the transport provider loses EVERYTHING (the
 *      message-losing double: pull delivers nothing, forever). The
 *      durable plan classifies the published-unapplied envelopes as
 *      re-drive; a FRESH worker's recovery scan — driven entirely by
 *      the executions authority, ZERO queue involvement — converges
 *      every execution with EXACTLY ONE provider dispatch and
 *      EXACTLY ONE completion event per execution (no duplicated
 *      authoritative effects).
 *   R2 OUTAGE → BACKLOG → REPUBLISH: a queue-transport outage
 *      (typed transient failures, bounded publish budget) leaves the
 *      envelope republishable; the outage ends; the bounded
 *      republish (the dispatcher's crash/outage recovery — reads
 *      PostgreSQL only) delivers through the REAL transport; a
 *      worker consumes and converges; the plan then classifies the
 *      envelope converged (consumed ⇒ applied).
 *
 * DISCRIMINATION:
 *
 *   R3 REPLAY NEVER DUPLICATES: the converged executions' event
 *      ledgers carry exactly ONE completion per execution and the
 *      sandbox provider saw exactly ONE dispatch per execution —
 *      replay re-drives THROUGH idempotency, it cannot double-effect.
 *   R4 THE PLAN IS AUTHORITY-ONLY: the transport provider's state
 *      (delivered/lost/foreign messages) does not appear in the
 *      recovery plan — the classification is exactly the durable
 *      envelope states; an unknown state outside the closed
 *      vocabulary is a fail-closed error, never a guess.
 *   R5 ORCHESTRATION LOSS: after the orchestration provider loses
 *      its instances, the durable wait scan classifies exactly what
 *      the coordinator recovery must do (live/startable/signaled/
 *      terminal per the REAL wait records), and the recovery is
 *      driven by PostgreSQL — the same durable state converges.
 */
import { expect, test } from "vitest";
import { Client } from "pg";
import { createOrchestrationResolutionEffect } from "../../../src/modules/executions/adapters/workflow-effect";
import { createOrchestrationSource } from "../../../src/modules/executions/adapters/orchestration-source";
import { DurableDispatcher } from "../../../src/platform/queue/dispatcher";
import { QueueTransportError } from "../../../src/platform/queue/port";
import { createOrchestrationCoordinator } from "../../../src/platform/workflow/engine";
import {
  planOrchestrationRecovery,
  planTransportRecovery,
} from "../../../src/platform/recovery/transport-recovery";
import { MessageLosingQueueTransport } from "../../../src/platform/recovery/outage";
import { OutageSimulatedQueueTransport } from "../../../src/platform/recovery/outage";
import { definePgSuite } from "./harness";
import { generateId, seedWorkerFabricWorld } from "./worker-world";
import { ORCHESTRATOR_ACTOR_ID, InMemoryWorkflowTransport, seedWorkflowWorld, TEST_BOUNDS, TEST_POLICY } from "./workflow-world";

definePgSuite("queue/workflow replay after provider loss (WORK-048 D-07 AC3)", (ctx) => {
  const world = () => seedWorkerFabricWorld(ctx.port);

  /**
   * The corruption-drift session (replication-role mode — the same
   * mode a restore runs in): writes the out-of-vocabulary drift a
   * foreign restore could leave behind, bypassing the live CHECK
   * guards the way a restore does.
   */
  const connectReplica = async (context: typeof ctx): Promise<Client> => {
    const client = new Client({
      connectionString: `${context.adminUrl.replace(/\/[^/]*$/, "")}/${context.databaseName}`,
    });
    await client.connect();
    await client.query("SET session_replication_role = replica");
    return client;
  };

  /**
   * The interrupted worker's durable state (the WORK-046 C-matrix
   * convention): governed start + live claim + short-TTL lease — the
   * exact in-flight state a lost transport/worker leaves behind.
   */
  const interruptedWorker = async (
    w: Awaited<ReturnType<typeof world>>,
    executionId: string,
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
      ttlMs: 50,
      reason: "interrupted-worker",
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

  /** Age the claim's heartbeat past the stale bound; the short lease expires. */
  const agePastBounds = async (claimId: string): Promise<void> => {
    await ctx.port.execute({
      sql: `UPDATE compute_plane.worker_claims
SET last_heartbeat_at = now() - interval '10 minutes'
WHERE id = $1`,
      parameters: [claimId],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  };

  test("R1+R3 total transport loss: the authority re-drive converges everything with exactly one dispatch and one completion per execution", async () => {
    const w = await world();
    const executionOne = await w.createDispatchedExecution("r1-one");
    const executionTwo = await w.createDispatchedExecution("r1-two");
    const interruptedOne = await interruptedWorker(w, executionOne);
    const interruptedTwo = await interruptedWorker(w, executionTwo);
    await agePastBounds(interruptedOne.claim.id);
    await agePastBounds(interruptedTwo.claim.id);

    // THE TRANSPORT PROVIDER LOSES EVERYTHING: pull delivers nothing,
    // forever (the honest worst case — acknowledged and dropped).
    const lossy = new MessageLosingQueueTransport(w.transport);
    const batch = await lossy.pull({ batchSize: 10 });
    expect(batch.messages).toHaveLength(0);

    // The durable plan classifies the in-flight envelopes from the
    // AUTHORITY ONLY (published, not yet applied → re-drive).
    const plan = await planTransportRecovery(ctx.port);
    const byExecution = new Map(plan.items.map((item) => [item.executionId, item]));
    expect(plan.planned).toBe(true);
    expect(byExecution.get(executionOne)?.recoveryClass).toBe("re-drive");
    expect(byExecution.get(executionOne)?.state).toBe("published");
    expect(byExecution.get(executionTwo)?.recoveryClass).toBe("re-drive");
    expect(plan.byClass["re-drive"]).toBeGreaterThanOrEqual(2);

    // A FRESH worker converges everything from the executions
    // authority — the recovery scan is queue-independent (the lossy
    // transport delivered nothing; recovery never asked it to).
    const fabric = await w.createFabric();
    const recovery = await fabric.recover();
    expect(recovery.abandonedClaims).toBe(2);
    expect(recovery.claimed).toBe(2);
    expect(recovery.applied + recovery.converged).toBe(2);

    // R3 — EXACTLY ONE provider dispatch per execution (2 total, the
    // interrupted workers never dispatched) and EXACTLY ONE
    // completion event per execution (no duplicated effects).
    expect(w.provider.dispatchCount()).toBe(2);
    for (const executionId of [executionOne, executionTwo]) {
      const execution = await w.service.getExecution(w.applicationId, executionId);
      expect(execution?.status).toBe("COMPLETED");
      const events = await w.eventsOf(executionId);
      const completions = events.filter(
        (event) => event.kind === "execution.pass",
      );
      expect(completions).toHaveLength(1);
      const lease = await w.lease.inspect(w.applicationId, executionId);
      expect(lease?.epoch).toBe(2); // fresh epoch — the stale pair is fenced forever
      expect(lease?.ownerId).not.toBe(interruptedOne.workerId);
    }
    await fabric.stop("test-complete");
  });

  test("R2 outage → backlog → bounded republish → convergence; the plan ends converged (consumed ⇒ applied)", async () => {
    const w = await world();

    // Create + drive one execution through the REAL lifecycle.
    const receipt = await w.service.createExecution(
      { applicationId: w.applicationId, environmentId: w.environmentId, task: w.taskFor("r2") },
      "create-r2",
      { actorId: "00000000-0000-7000-8000-0000000000aa", tenantId: w.tenantId },
    );
    const executionId = receipt.executionId;
    const scope = {
      actorId: "00000000-0000-7000-8000-0000000000aa",
      applicationId: w.applicationId,
      tenantId: w.tenantId,
      executionId,
    };
    for (const [command, key] of [
      ["authorize", "auth-r2"],
      ["plan", "plan-r2"],
      ["queue", "queue-r2"],
    ] as const) {
      await w.service.transition({ ...scope, command }, key);
    }

    // The dispatcher over the OUTAGE-WRAPPED transport (the drill
    // composition: same authority store, transport wrapped).
    const outage = new OutageSimulatedQueueTransport(w.transport);
    const dispatcher = new DurableDispatcher({
      store: w.correlation,
      transport: outage,
      policy: {
        maxPublishAttempts: 3,
        maxDeliveryAttempts: 3,
        maxReplays: 3,
        retryBackoffMs: 0,
      },
      generateId,
      now: () => new Date(),
      sleep: async () => undefined,
    });

    // THE OUTAGE: every publish fails with the typed transient error.
    outage.begin();
    const outcome = await dispatcher.dispatchExecution({
      executionId,
      applicationId: w.applicationId,
      tenantId: w.tenantId,
    });
    expect(outcome.published).toBe(false);
    expect(outcome.envelope.publishAttempts).toBeGreaterThanOrEqual(1);
    expect(
      outcome.envelope.state === "recorded" || outcome.envelope.state === "backlogged",
    ).toBe(true);
    expect(outage.failedOperations).toBeGreaterThanOrEqual(1);

    // The typed error class is the transport-unavailable class.
    await expect(outage.publish({ body: "probe", contentType: "application/json" })).rejects.toThrow(
      QueueTransportError,
    );

    // The durable plan classifies the envelope REPUBLISHABLE (the
    // outage's bounded backlog — never a lost intent).
    const duringOutage = await planTransportRecovery(ctx.port);
    const item = duringOutage.items.find((entry) => entry.executionId === executionId);
    expect(item?.recoveryClass).toBe("republish");

    // THE OUTAGE ENDS: the bounded republish (PostgreSQL-driven)
    // delivers through the REAL transport.
    outage.end();
    const republished = await dispatcher.republishPending(10);
    expect(republished).toHaveLength(1);
    expect(republished[0]?.published).toBe(true);

    // A worker consumes the delivery and converges the execution.
    const fabric = await w.createFabric();
    for (let i = 0; i < 3; i += 1) {
      await fabric.consumeBatch();
    }
    const execution = await w.service.getExecution(w.applicationId, executionId);
    expect(execution?.status).toBe("COMPLETED");
    expect(w.provider.dispatchCount()).toBe(1); // exactly one dispatch

    // The plan ends CONVERGED (consumed ⇒ applied: the
    // transport-vs-authority boundary held).
    const after = await planTransportRecovery(ctx.port);
    const converged = after.items.find((entry) => entry.executionId === executionId);
    expect(converged?.state).toBe("consumed");
    expect(converged?.recoveryClass).toBe("converged");
    expect(converged?.appliedAt).not.toBeNull();
    await fabric.stop("test-complete");
  });

  test("R4 the plan is authority-only: provider message state never appears; unknown states fail closed", async () => {
    const w = await world();
    const executionId = await w.createDispatchedExecution("r4-authority");

    // Foreign messages sitting in the transport (provider-local
    // state) do not change the durable classification.
    await w.transport.publish({ body: "foreign-1", contentType: "application/json" });
    await w.transport.publish({ body: "foreign-2", contentType: "application/json" });
    const planBefore = await planTransportRecovery(ctx.port);

    // Losing the provider entirely (all messages gone) does not
    // change the plan either — the envelopes are the authority.
    const lossy = new MessageLosingQueueTransport(w.transport);
    await lossy.pull({ batchSize: 10 });
    const planAfter = await planTransportRecovery(ctx.port);
    expect(planAfter.items.length).toBe(planBefore.items.length);
    for (const item of planAfter.items) {
      const before = planBefore.items.find((entry) => entry.envelopeId === item.envelopeId);
      expect(before?.recoveryClass).toBe(item.recoveryClass);
    }

    // An envelope state OUTSIDE the closed vocabulary is corruption,
    // not a recovery decision — the planner fails closed. The
    // vocabulary is CHECK-guarded on live writes; a foreign restore
    // bypasses the guards by construction (replication-role mode),
    // so the simulation writes the drift the same way.
    const spoofedId = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO queue_transport.dispatch_envelopes (
id, purpose, correlation_key, tenant_id, application_id, execution_id,
payload, payload_digest, state, publish_attempts, replay_of, created_at)
VALUES ($1, 'execution-dispatch', $2, $3, $4, $5, '{}'::jsonb, $6, 'published', 0, NULL, now())`,
      parameters: [
        spoofedId,
        `execution-dispatch:${spoofedId}`,
        w.tenantId,
        w.applicationId,
        executionId,
        "0".repeat(64),
      ],
    });
    const driftClient = await connectReplica(ctx);
    try {
      // The state vocabulary is CHECK-guarded even in replica mode;
      // the corrupted-restored-state simulation drops the guard, writes
      // the drift, and re-adds it (the disposable database is dropped
      // after the suite — the drifted schema never survives).
      await driftClient.query(
        "ALTER TABLE queue_transport.dispatch_envelopes DROP CONSTRAINT envelope_state_vocabulary",
      );
      await driftClient.query(
        "UPDATE queue_transport.dispatch_envelopes SET state = 'spoofed' WHERE id = $1",
        [spoofedId],
      );
      await driftClient.query(
        `ALTER TABLE queue_transport.dispatch_envelopes ADD CONSTRAINT envelope_state_vocabulary CHECK (
           state IN ('recorded', 'published', 'backlogged', 'consumed', 'dead-lettered')) NOT VALID`,
      );
      await expect(planTransportRecovery(ctx.port)).rejects.toThrow(/unknown state "spoofed"/);
    } finally {
      await driftClient.query(
        "DELETE FROM queue_transport.dispatch_envelopes WHERE id = $1",
        [spoofedId],
      );
      await driftClient.end();
    }
    const healed = await planTransportRecovery(ctx.port);
    expect(healed.planned).toBe(true);
  });

  test("R5 orchestration loss: the durable wait scan classifies the recovery; a REPLACED provider converges from PostgreSQL", async () => {
    const w = await seedWorkflowWorld(ctx.port);

    // Two executions armed cleanly (live durable waits + provider
    // instances).
    const waitingOne = await w.createWaitingExecution("d07-wait-one", "human");
    const waitingTwo = await w.createWaitingExecution("d07-wait-two", "tool");
    await w.coordinator.armWaitingExecutions(50);

    // A THIRD execution whose provider start is REFUSED (the
    // provider-outage convention): its wait stays `recorded` — the
    // STARTABLE recovery class.
    const waitingThree = await w.createWaitingExecution("d07-wait-three", "user");
    w.transport.failNextStarts(1, new Error("simulated orchestration-provider outage"));
    await w.coordinator.armWaitingExecutions(50).catch(() => undefined);

    // The durable wait scan classifies EXACTLY what recovery must do:
    // three live waits, at least one startable, none terminal.
    const plan = await planOrchestrationRecovery(ctx.port);
    expect(plan.liveWaits).toBeGreaterThanOrEqual(3);
    expect(plan.startableWaits).toBeGreaterThanOrEqual(1);
    expect(plan.terminalWaits).toBe(0);
    expect(plan.waitingExecutions).toContain(waitingOne);
    expect(plan.waitingExecutions).toContain(waitingTwo);
    expect(plan.waitingExecutions).toContain(waitingThree);

    // THE ORCHESTRATION PROVIDER IS REPLACED (provider exit): a fresh
    // coordinator over the SAME durable PostgreSQL state and a
    // BRAND-NEW provider (no instances — the old provider's state is
    // GONE). recoverPending re-drives the recorded starts from the
    // authority: the startable wait starts ON THE NEW PROVIDER.
    const freshTransport = new InMemoryWorkflowTransport();
    const coordinator = createOrchestrationCoordinator({
      store: w.store,
      workflow: freshTransport,
      effect: createOrchestrationResolutionEffect({
        service: w.service,
        orchestratorActorId: ORCHESTRATOR_ACTOR_ID,
      }),
      source: createOrchestrationSource({
        db: w.db,
        deadlines: { waitTimeoutMs: 0 },
        now: () => new Date(),
      }),
      policy: TEST_POLICY,
      bounds: TEST_BOUNDS,
      generateId,
      now: () => new Date(),
      sleep: async () => undefined,
    });
    const report = await coordinator.recoverPending(50);
    expect(report.startsDriven).toBeGreaterThanOrEqual(1);

    // The durable plan now has ZERO startable waits (everything is
    // live on the replacement provider); the executions remain
    // WAITING in the authority (recovery never invents outcomes).
    const afterRecovery = await planOrchestrationRecovery(ctx.port);
    expect(afterRecovery.planned).toBe(true);
    expect(afterRecovery.startableWaits).toBe(0);
    expect(afterRecovery.liveWaits).toBeGreaterThanOrEqual(3);
    expect(await w.statusOf(waitingOne)).toMatch(/WAITING/);
    expect(await w.statusOf(waitingTwo)).toMatch(/WAITING/);
    expect(await w.statusOf(waitingThree)).toMatch(/WAITING/);
  });
});
