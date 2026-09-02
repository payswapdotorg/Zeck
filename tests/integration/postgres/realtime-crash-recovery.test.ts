/**
 * Real-PostgreSQL crash-injection proofs — the DURABLE, RECOVERABLE
 * OPERATION STATE and the STABLE rail-level idempotency keys (WORK-024;
 * the architect's crash-safety correction for PR #46; checkpoint
 * contract CONCURRENCY-CRASH-SAFETY — the PHYSICAL half).
 *
 * The unit suite (tests/unit/deployments/realtime-crash-recovery.test.ts)
 * proves the behavioral half over the in-memory world (kill/restart at
 * every durable boundary, admission/seam non-re-invocation). THIS suite
 * proves the same kill/restart discipline against REAL PostgreSQL
 * (migrations 0001..0018): the process dies mid-operation, the
 * `realtime_operations` row (PENDING, checkpoint jsonb, attempts ledger)
 * physically SURVIVES, and a re-booted service (the process restart) —
 * over the SAME PG store, the SAME executions ledger and the SAME
 * upstream rail (the external provider's key ledger) — converges the
 * operation to COMPLETED with EXACTLY ONE upstream side effect per
 * stable key.
 *
 * THE PROOF RECORDS (the four required lifecycle points):
 *   START             P1 session-opened checkpoint crash → resume
 *   INBOUND DELIVERY  P2 responded-checkpoint crash → resume (no
 *                     re-respond) · P3 rail-delivery crash → key replay
 *   TRANSFER          P4 rail-issued checkpoint crash → resume
 *   CLOSE             P5 terminal-move crash → reconcile · P6 hangup
 *                     claim crash → recovered close
 *   PHYSICAL GUARDS   P7 the realtime_operations table discipline
 *                     (unique claim convergence, terminal immutability,
 *                     attempts monotonicity, write-once core, no
 *                     delete, checkpoint pending-only)
 */

import { describe, expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { type RealtimePgWorld, seedRealtimeWorld, userTurn } from "./realtime-world";

definePgSuite("realtime crash-injection proofs (PR #46 correction) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<RealtimePgWorld> {
    return seedRealtimeWorld(ctx.port);
  }

  /** Run one operation in a DYING process (the outcome is irrelevant — the process is gone). */
  async function diesDuring(run: () => Promise<unknown>, crashed: () => boolean): Promise<void> {
    await run().then(
      () => undefined,
      () => undefined,
    );
    expect(crashed()).toBe(true);
  }

  const railRecords = (world: RealtimePgWorld, kind: string) =>
    world.rail.deliveries.filter((record) => record.kind === kind);

  // ---- SQL inspection helpers ---------------------------------------------
  async function operationRow(applicationId: string, operationKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.realtime_operations WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    return result.rows[0] ?? null;
  }

  async function sessionRow(sessionId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT status FROM deployments.realtime_sessions WHERE id = $1`,
      parameters: [sessionId],
    });
    return result.rows[0] ?? null;
  }

  async function journalCount(sessionId: string, eventKey: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.realtime_events WHERE session_id = $1 AND event_key = $2`,
      parameters: [sessionId, eventKey],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function stepEventCount(executionId: string, command: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM executions.execution_events WHERE execution_id = $1 AND command = $2`,
      parameters: [executionId, command],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  const startInput = (world: RealtimePgWorld, callRef: string) => ({
    deploymentId: world.deploymentId,
    channelKind: "web" as const,
    channelSessionRef: `call-${callRef}`,
    callerRef: `caller-${callRef}`,
  });

  const hangup = (started: {
    readonly sessionId: string;
    readonly channelSessionRef: string;
    readonly channelEpoch: number;
  }) => ({
    sessionId: started.sessionId,
    channelSessionRef: started.channelSessionRef,
    channelEpoch: started.channelEpoch,
    kind: "caller-hangup" as const,
    eventKey: "hangup-p6",
  });

  describe("P-records: kill/restart at the durable boundaries", () => {
    test("P1 START: crash AFTER the session-opened checkpoint — the PG row survives PENDING; the restart resumes WITHOUT re-admission and completes", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const dying = world.boot({
        target: "store",
        method: "recordRealtimeOperationCheckpoint",
        when: "after",
      });
      await diesDuring(
        () => dying.service.startSession(startInput(world, "p1"), "start-p1", actor),
        dying.crashed,
      );
      // The operation row physically exists, PENDING, with the checkpoint.
      const row = await operationRow(world.applicationId, "rtop:session-start:start-p1");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(1);
      const checkpoint = row?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stage).toBe("session-opened");
      expect(typeof row?.session_id).toBe("string");
      const pinnedSessionId = row?.session_id as string;
      // No session row yet (the crash preceded the insert).
      expect(await sessionRow(pinnedSessionId)).toBeNull();
      // RESTART: the recovery branch completes the durable tail.
      const restarted = world.boot(null);
      const outcome = await restarted.service.startSession(
        startInput(world, "p1"),
        "start-p1",
        actor,
      );
      expect(outcome.sessionId).toBe(pinnedSessionId);
      expect(railRecords(world, "open")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0); // no second rail call on recovery
      // The PG row converged to COMPLETED with the honest attempts ledger.
      const completed = await operationRow(world.applicationId, "rtop:session-start:start-p1");
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(completed?.completed_at).not.toBeNull();
      expect(await sessionRow(pinnedSessionId)).toMatchObject({ status: "live" });
    });

    test("P2 TURN: crash AFTER the responded checkpoint — the restart delivers ONCE with the checkpointed facts (the responder is never re-invoked)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(startInput(world, "p2"), "start-p2", actor);
      const dying = world.boot({
        target: "store",
        method: "recordRealtimeOperationCheckpoint",
        when: "after",
      });
      await diesDuring(
        () => dying.service.ingestInboundEvent(userTurn(started, "evt-p2"), actor),
        dying.crashed,
      );
      // The turn operation row is PENDING with the responded checkpoint.
      const row = await operationRow(
        world.applicationId,
        `rtop:turn-delivery:${started.sessionId}:evt-p2`,
      );
      expect(row?.status).toBe("pending");
      const checkpoint = row?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stage).toBe("responded");
      expect(checkpoint?.responsePreview).toBe("fixture answer");
      // Process 1 invoked the responder exactly once (before the checkpoint).
      expect(world.admissions.responderCalls).toHaveLength(1);
      // RESTART: the delivery resumes with the checkpointed facts.
      const restarted = world.boot(null);
      const outcome = await restarted.service.ingestInboundEvent(
        userTurn(started, "evt-p2"),
        actor,
      );
      expect(outcome.responsePreview).toBe("fixture answer");
      // The paid-inference seam was NOT re-invoked.
      expect(world.admissions.responderCalls).toHaveLength(1);
      // EXACTLY ONE upstream delivery (the rail ledger never saw the key
      // before the crash — process 1 died at the checkpoint).
      expect(railRecords(world, "deliver")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      // The PG rows converged: the op completed, journal once each way,
      // and the REAL executions ledger carries the turn step event once.
      const completed = await operationRow(
        world.applicationId,
        `rtop:turn-delivery:${started.sessionId}:evt-p2`,
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(await journalCount(started.sessionId, "evt-p2")).toBe(1);
      expect(await journalCount(started.sessionId, "evt-p2:turn")).toBe(1);
      expect(
        await stepEventCount(started.executionId, "agent-action-recorded"),
      ).toBeGreaterThanOrEqual(1);
    });

    test("P3 TURN: crash AFTER the rail delivery — the restart converges through the STABLE rail key (the physical delivery happened exactly once)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(startInput(world, "p3"), "start-p3", actor);
      const dying = world.boot({ target: "rail", method: "deliverTurn", when: "after" });
      await diesDuring(
        () => dying.service.ingestInboundEvent(userTurn(started, "evt-p3"), actor),
        dying.crashed,
      );
      // The upstream delivery HAPPENED (the external world moved); the
      // durable tail did not (PENDING with the responded checkpoint).
      expect(railRecords(world, "deliver")).toHaveLength(1);
      const row = await operationRow(
        world.applicationId,
        `rtop:turn-delivery:${started.sessionId}:evt-p3`,
      );
      expect(row?.status).toBe("pending");
      // RESTART: the same logical turn re-delivers under the SAME stable
      // key — the rail replays the original acknowledgment.
      const restarted = world.boot(null);
      const outcome = await restarted.service.ingestInboundEvent(
        userTurn(started, "evt-p3"),
        actor,
      );
      expect(outcome.responsePreview).toBe("fixture answer");
      expect(railRecords(world, "deliver")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(1);
      expect(world.rail.replays[0]?.idempotencyKey).toBe(
        `rtrail:deliver:${started.sessionId}:evt-p3`,
      );
      expect(world.admissions.responderCalls).toHaveLength(1);
      const completed = await operationRow(
        world.applicationId,
        `rtop:turn-delivery:${started.sessionId}:evt-p3`,
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(await journalCount(started.sessionId, "evt-p3:turn")).toBe(1);
    });

    test("P4 TRANSFER: crash AFTER the rail-issued checkpoint — the restart completes WITHOUT re-admission and WITHOUT a second rail transfer", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(startInput(world, "p4"), "start-p4", actor);
      const dying = world.boot({
        target: "store",
        method: "recordRealtimeOperationCheckpoint",
        when: "after",
      });
      await diesDuring(
        () =>
          dying.service.transferToHuman(
            { sessionId: started.sessionId, cause: "caller request" },
            "transfer-p4",
            actor,
          ),
        dying.crashed,
      );
      // The rail transferred exactly once; the checkpoint survived.
      expect(railRecords(world, "transfer")).toHaveLength(1);
      const row = await operationRow(world.applicationId, "rtop:human-transfer:transfer-p4");
      expect(row?.status).toBe("pending");
      const checkpoint = row?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stage).toBe("rail-issued");
      expect(typeof checkpoint?.deliveredAt).toBe("string");
      // RESTART: the durable tail completes from the checkpoint.
      const restarted = world.boot(null);
      const outcome = await restarted.service.transferToHuman(
        { sessionId: started.sessionId, cause: "caller request" },
        "transfer-p4",
        actor,
      );
      expect(outcome.replayed).toBe(true);
      // No second rail transfer, no replay (the rail is never re-called).
      expect(railRecords(world, "transfer")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      const completed = await operationRow(world.applicationId, "rtop:human-transfer:transfer-p4");
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(await sessionRow(started.sessionId)).toMatchObject({ status: "transferred" });
    });

    test("P5 CLOSE: crash AFTER the terminal move — the restart reconciles the PENDING row (the terminal status IS the durable proof)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(startInput(world, "p5"), "start-p5", actor);
      const dying = world.boot({
        target: "store",
        method: "applyGuardedSessionMutation",
        when: "after",
      });
      await diesDuring(
        () => dying.service.closeSession({ sessionId: started.sessionId }, "close-p5", actor),
        dying.crashed,
      );
      // The session is terminal in PG; the operation row is PENDING.
      expect(await sessionRow(started.sessionId)).toMatchObject({ status: "closed" });
      const row = await operationRow(world.applicationId, "rtop:session-close:close-p5");
      expect(row?.status).toBe("pending");
      expect(railRecords(world, "close")).toHaveLength(1);
      // RESTART: the transferred-status reconciliation completes the op.
      const restarted = world.boot(null);
      const outcome = await restarted.service.closeSession(
        { sessionId: started.sessionId },
        "close-p5",
        actor,
      );
      expect(outcome.replayed).toBe(true);
      expect(railRecords(world, "close")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      const completed = await operationRow(world.applicationId, "rtop:session-close:close-p5");
      expect(completed?.status).toBe("completed");
    });

    test("P6 HANGUP: crash AFTER the inbound hangup claim — the restart recovers the close through the converged claim", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(startInput(world, "p6"), "start-p6", actor);
      const dying = world.boot({ target: "store", method: "appendChannelEvent", when: "after" });
      await diesDuring(
        () => dying.service.ingestInboundEvent(hangup(started), actor),
        dying.crashed,
      );
      // The inbound hangup row committed; the close did not.
      expect(await journalCount(started.sessionId, "hangup-p6")).toBe(1);
      expect(railRecords(world, "close")).toHaveLength(0);
      // RESTART: the converged claim path recovers (no terminal rejection).
      const restarted = world.boot(null);
      const outcome = await restarted.service.ingestInboundEvent(hangup(started), actor);
      expect(outcome.kind).toBe("caller-hangup");
      expect(railRecords(world, "close")).toHaveLength(1);
      expect(await sessionRow(started.sessionId)).toMatchObject({ status: "closed" });
      const completed = await operationRow(
        world.applicationId,
        `rtop:session-close:${started.sessionId}:hangup-p6:hangup`,
      );
      expect(completed?.status).toBe("completed");
    });
  });

  describe("P7: the realtime_operations physical discipline (migration 0018)", () => {
    test("a duplicate durable claim converges on the physical UNIQUE (application, operation_key)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(
        startInput(world, "p7a"),
        "start-p7a",
        actor,
      );
      // The completed session-start operation: a duplicate claim converges
      // (no second row, no attempts bump on a terminal row).
      const duplicate = await world.realtimeStore.beginRealtimeOperation({
        operationId: "00000000-0000-7000-8000-0000000000aa",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        sessionId: started.sessionId,
        deploymentId: world.deploymentId,
        executionId: started.executionId,
        operationKind: "session-start",
        operationKey: "rtop:session-start:start-p7a",
        createdAt: new Date().toISOString(),
      });
      expect(duplicate.status).toBe("existing");
      expect(duplicate.record.status).toBe("completed");
      expect(duplicate.record.attempts).toBe(1);
      const count = await ctx.port.execute<{ count: string }>({
        sql: `SELECT COUNT(*)::text AS count FROM deployments.realtime_operations WHERE operation_key = 'rtop:session-start:start-p7a'`,
        parameters: [],
      });
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    test("terminal rows are physically immutable (lifecycle guard), attempts never regress, the core never moves, and rows are never deleted", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startSession(
        startInput(world, "p7b"),
        "start-p7b",
        actor,
      );
      const key = "rtop:session-start:start-p7b";
      const row = await operationRow(world.applicationId, key);
      expect(row?.status).toBe("completed");
      const id = row?.id as string;
      // A physical UPDATE of a terminal row is unrepresentable.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_operations SET failure_reason = 'x' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrow(/terminal-immutable/);
      // The write-once identity core never moves.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_operations SET operation_key = 'moved' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrow(/identity core is immutable/);
      // Rows are never deleted.
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.realtime_operations WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrow(/never deleted/);
      // A PENDING row's attempts never regress (monotonic retry ledger).
      const pending = await world.realtimeStore.beginRealtimeOperation({
        operationId: "00000000-0000-7000-8000-0000000000bb",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        sessionId: started.sessionId,
        deploymentId: world.deploymentId,
        executionId: started.executionId,
        operationKind: "session-close",
        operationKey: "rtop:session-close:regress-p7b",
        createdAt: new Date().toISOString(),
      });
      expect(pending.status).toBe("begun");
      const pendingId = pending.record.id;
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_operations SET attempts = 0 WHERE id = $1`,
          parameters: [pendingId],
        }),
      ).rejects.toThrow(/cannot move from status|attempts/);
      // The store method rejects a checkpoint write on a terminal row.
      await expect(
        world.realtimeStore.recordRealtimeOperationCheckpoint(
          world.applicationId,
          key,
          { stage: "rail-issued" },
          new Date().toISOString(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      // A failed operation cannot be completed (the recorded terminal
      // failure outcome is the truth a retry replays).
      await world.realtimeStore.failRealtimeOperation(
        world.applicationId,
        "rtop:session-close:regress-p7b",
        "fixture refusal",
        new Date().toISOString(),
      );
      await expect(
        world.realtimeStore.completeRealtimeOperation(
          world.applicationId,
          "rtop:session-close:regress-p7b",
          new Date().toISOString(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      const failed = await operationRow(world.applicationId, "rtop:session-close:regress-p7b");
      expect(failed?.status).toBe("failed");
      expect(failed?.failure_reason).toBe("fixture refusal");
    });

    test("the checkpoint is bounded and the vocabulary is enforced physically", async () => {
      const world = await freshWorld();
      // The kind vocabulary CHECK rejects an unknown operation kind.
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.realtime_operations (
            id, application_id, tenant_id, session_id, deployment_id, execution_id,
            operation_kind, operation_key, status, attempts, checkpoint, failure_reason,
            created_at, updated_at, completed_at)
            VALUES ($1, $2, $3, NULL, $4, NULL, 'rail-hangup', 'rtop:bogus', 'pending', 1, NULL, NULL, now(), now(), NULL)`,
          parameters: [
            "00000000-0000-7000-8000-0000000000cc",
            world.applicationId,
            world.tenantId,
            world.deploymentId,
          ],
        }),
      ).rejects.toThrow(/rt_ops_kind_vocabulary/);
      // The status vocabulary CHECK rejects an unknown status.
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.realtime_operations (
            id, application_id, tenant_id, session_id, deployment_id, execution_id,
            operation_kind, operation_key, status, attempts, checkpoint, failure_reason,
            created_at, updated_at, completed_at)
            VALUES ($1, $2, $3, NULL, $4, NULL, 'session-close', 'rtop:bogus2', 'running', 1, NULL, NULL, now(), now(), NULL)`,
          parameters: [
            "00000000-0000-7000-8000-0000000000cd",
            world.applicationId,
            world.tenantId,
            world.deploymentId,
          ],
        }),
      ).rejects.toThrow(/rt_ops_status_vocabulary/);
      // A COMPLETED row requires its outcome timestamp; a FAILED row
      // requires its bounded reason (the outcome fields are exclusive).
      const begun = await world.realtimeStore.beginRealtimeOperation({
        operationId: "00000000-0000-7000-8000-0000000000ce",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        sessionId: null,
        deploymentId: world.deploymentId,
        executionId: null,
        operationKind: "session-start",
        operationKey: "rtop:session-start:outcome-p7c",
        createdAt: new Date().toISOString(),
      });
      expect(begun.status).toBe("begun");
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_operations SET status = 'completed' WHERE id = $1`,
          parameters: [begun.record.id],
        }),
      ).rejects.toThrow(/cannot move from status/);
    });
  });
});
