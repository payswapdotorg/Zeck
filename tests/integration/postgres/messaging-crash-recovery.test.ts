/**
 * Real-PostgreSQL crash-injection proofs — the DURABLE, RECOVERABLE
 * OPERATION STATE and the STABLE rail-level idempotency keys (WORK-025;
 * checkpoint contract CONCURRENCY-CRASH-SAFETY — the PHYSICAL half).
 *
 * The unit suite (tests/unit/deployments/messaging-crash-recovery.test.ts)
 * proves the behavioral half over the in-memory world (23 C-records:
 * kill/restart at every durable boundary, admission/seam
 * non-re-invocation, key discipline). THIS suite proves the same
 * kill/restart discipline against REAL PostgreSQL (migrations
 * 0001..0020): the process dies mid-operation, the
 * `messaging_operations` row (PENDING, checkpoint jsonb, attempts
 * ledger) physically SURVIVES, and a re-booted service (the process
 * restart) — over the SAME PG store, the SAME executions ledger and
 * the SAME upstream rail (the external provider's idempotency-key
 * ledger) — converges the operation to COMPLETED with EXACTLY ONE
 * upstream side effect per stable key.
 *
 * THE PROOF RECORDS (the required lifecycle points):
 *   START             P1 conversation-opened checkpoint crash → resume
 *   INBOUND TURN      P2 responded-checkpoint crash → resume (no
 *                     re-respond) · P3 rail-send crash → key replay
 *   DELIVERY APPLY    P4 evidence-row crash → converge the projection
 *                     · P5 projection crash → replay the outcome
 *   HUMAN ESCALATION  P6 rail-issued checkpoint crash → resume
 *   CLOSE             P7 terminal-move crash → reconcile
 *   PHYSICAL GUARDS   P8 the messaging_operations table discipline
 *                     (unique claim convergence, terminal immutability,
 *                     attempts monotonicity, write-once core, no
 *                     delete, vocabulary CHECKs)
 */

import { describe, expect, test } from "vitest";
import { definePgSuite } from "./harness";
import { type MessagingPgWorld, seedMessagingWorld, userMessage } from "./messaging-world";

definePgSuite("messaging crash-injection proofs (WORK-025) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<MessagingPgWorld> {
    return seedMessagingWorld(ctx.port);
  }

  /** Run one operation in a DYING process (the outcome is irrelevant — the process is gone). */
  async function diesDuring(run: () => Promise<unknown>, crashed: () => boolean): Promise<void> {
    await run().then(
      () => undefined,
      () => undefined,
    );
    expect(crashed()).toBe(true);
  }

  const railRecords = (world: MessagingPgWorld, kind: string) =>
    world.rail.sends.filter((record) => record.kind === kind);

  // ---- SQL inspection helpers ---------------------------------------------
  async function operationRow(applicationId: string, operationKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_operations WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    return result.rows[0] ?? null;
  }

  async function conversationRow(conversationId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT status, execution_id, pinned_plan_version FROM deployments.messaging_conversations WHERE id = $1`,
      parameters: [conversationId],
    });
    return result.rows[0] ?? null;
  }

  async function messageCount(conversationId: string, eventKey: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.messaging_messages WHERE conversation_id = $1 AND event_key = $2`,
      parameters: [conversationId, eventKey],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function messageRow(conversationId: string, eventKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_messages WHERE conversation_id = $1 AND event_key = $2`,
      parameters: [conversationId, eventKey],
    });
    return result.rows[0] ?? null;
  }

  async function deliveryCount(conversationId: string, callbackKey: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.messaging_deliveries WHERE conversation_id = $1 AND callback_key = $2`,
      parameters: [conversationId, callbackKey],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function escalationCount(conversationId: string, escalationKey: string) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.messaging_escalations WHERE conversation_id = $1 AND escalation_key = $2`,
      parameters: [conversationId, escalationKey],
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

  const startInput = (world: MessagingPgWorld, refSuffix: string) => ({
    deploymentId: world.deploymentId,
    channelKind: "web" as const,
    channelConversationRef: `channel-thread-${refSuffix}`,
  });

  describe("P-records: kill/restart at the durable boundaries", () => {
    test("P1 START: crash AFTER the conversation-opened checkpoint — the PG row survives PENDING; the restart resumes WITHOUT re-admission and completes", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const dying = world.boot({
        target: "store",
        method: "recordMessagingOperationCheckpoint",
        when: "after",
      });
      await diesDuring(
        () => dying.service.startConversation(startInput(world, "p1"), "start-p1", actor),
        dying.crashed,
      );
      // The operation row physically exists, PENDING, with the checkpoint.
      const row = await operationRow(world.applicationId, "msgop:conversation-start:start-p1");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(1);
      const checkpoint = row?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stage).toBe("conversation-opened");
      const pinnedConversationId = row?.conversation_id as string;
      expect(typeof pinnedConversationId).toBe("string");
      // No conversation row yet (the crash preceded the insert).
      expect(await conversationRow(pinnedConversationId)).toBeNull();
      // The rail opened the channel conversation exactly once (the
      // checkpoint follows the rail open).
      expect(railRecords(world, "open")).toHaveLength(1);
      // RESTART: the recovery branch completes the durable tail.
      const restarted = world.boot(null);
      const outcome = await restarted.service.startConversation(
        startInput(world, "p1"),
        "start-p1",
        actor,
      );
      expect(outcome.conversationId).toBe(pinnedConversationId);
      expect(outcome.channelConversationRef).toBe(`channel-thread-p1`);
      expect(railRecords(world, "open")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0); // no second rail call on recovery
      // The PG row converged to COMPLETED with the honest attempts ledger.
      const completed = await operationRow(
        world.applicationId,
        "msgop:conversation-start:start-p1",
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(completed?.completed_at).not.toBeNull();
      expect(await conversationRow(pinnedConversationId)).toMatchObject({ status: "active" });
      // The recovered start wrote its provenance: the agent-session-
      // started envelope + the marker row.
      expect(await stepEventCount(outcome.executionId, "agent-session-started")).toBe(1);
      expect(await messageCount(pinnedConversationId, "start-p1:conversation-started")).toBe(1);
    });

    test("P2 TURN: crash AFTER the responded checkpoint — the restart sends ONCE with the checkpointed facts (the responder is never re-invoked)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p2"),
        "start-p2",
        actor,
      );
      const dying = world.boot({
        target: "store",
        method: "recordMessagingOperationCheckpoint",
        when: "after",
      });
      await diesDuring(
        () =>
          dying.service.ingestInboundEvent(userMessage(started.conversationId, "evt-p2"), actor),
        dying.crashed,
      );
      // The turn operation row is PENDING with the responded checkpoint.
      const row = await operationRow(
        world.applicationId,
        `msgop:turn-reply:${started.conversationId}:evt-p2`,
      );
      expect(row?.status).toBe("pending");
      const checkpoint = row?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stage).toBe("responded");
      expect(checkpoint?.responsePreview).toBe("fixture answer");
      // Process 1 invoked the responder exactly once (before the checkpoint).
      expect(world.admissions.responderCalls).toHaveLength(1);
      // The inbound claim committed (the idempotency ledger row).
      expect(await messageCount(started.conversationId, "evt-p2")).toBe(1);
      // RESTART: the send resumes with the checkpointed facts.
      const restarted = world.boot(null);
      const outcome = await restarted.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-p2"),
        actor,
      );
      expect(outcome.reply?.responsePreview).toBe("fixture answer");
      // The paid-inference seam was NOT re-invoked.
      expect(world.admissions.responderCalls).toHaveLength(1);
      // EXACTLY ONE upstream send (the rail ledger never saw the key
      // before the crash — process 1 died at the checkpoint).
      expect(railRecords(world, "send")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      // The PG rows converged: the op completed, the ledger rows are
      // once each way, and the REAL executions ledger carries the turn
      // step event once.
      const completed = await operationRow(
        world.applicationId,
        `msgop:turn-reply:${started.conversationId}:evt-p2`,
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(await messageCount(started.conversationId, "evt-p2:reply")).toBe(1);
      expect(await stepEventCount(started.executionId, "agent-action-recorded")).toBe(1);
    });

    test("P3 TURN: crash AFTER the rail send — the restart converges through the STABLE rail key (the physical send happened exactly once)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p3"),
        "start-p3",
        actor,
      );
      const dying = world.boot({ target: "rail", method: "sendMessage", when: "after" });
      await diesDuring(
        () =>
          dying.service.ingestInboundEvent(userMessage(started.conversationId, "evt-p3"), actor),
        dying.crashed,
      );
      // The upstream send HAPPENED (the external world moved); the
      // durable tail did not (PENDING with the responded checkpoint).
      expect(railRecords(world, "send")).toHaveLength(1);
      const row = await operationRow(
        world.applicationId,
        `msgop:turn-reply:${started.conversationId}:evt-p3`,
      );
      expect(row?.status).toBe("pending");
      // RESTART: the same logical turn re-sends under the SAME stable
      // key — the rail replays the original acknowledgment.
      const restarted = world.boot(null);
      const outcome = await restarted.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-p3"),
        actor,
      );
      expect(outcome.reply?.responsePreview).toBe("fixture answer");
      expect(railRecords(world, "send")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(1);
      expect(world.rail.replays[0]?.idempotencyKey).toBe(
        `msgrail:send:${started.conversationId}:evt-p3`,
      );
      expect(world.admissions.responderCalls).toHaveLength(1);
      const completed = await operationRow(
        world.applicationId,
        `msgop:turn-reply:${started.conversationId}:evt-p3`,
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(await messageCount(started.conversationId, "evt-p3:reply")).toBe(1);
    });

    test("P4 DELIVERY: crash AFTER the evidence row (before the projection) — the restart converges the projection exactly once", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p4"),
        "start-p4",
        actor,
      );
      await clean.service.ingestInboundEvent(userMessage(started.conversationId, "evt-p4"), actor);
      const dying = world.boot({ target: "store", method: "appendDelivery", when: "after" });
      const callback = {
        conversationId: started.conversationId,
        messageKey: "evt-p4:reply",
        status: "delivered" as const,
        callbackKey: "cb-p4",
      };
      await diesDuring(() => dying.service.applyDeliveryStatus(callback, actor), dying.crashed);
      // The evidence row committed; the projection did NOT move.
      expect(await deliveryCount(started.conversationId, "cb-p4")).toBe(1);
      const reply = await messageRow(started.conversationId, "evt-p4:reply");
      expect(reply?.delivery_status).toBe("sent");
      const row = await operationRow(
        world.applicationId,
        `msgop:delivery-apply:${started.conversationId}:cb-p4`,
      );
      expect(row?.status).toBe("pending");
      // RESTART: the callback application converges.
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyDeliveryStatus(callback, actor);
      expect(outcome.deliveryStatus).toBe("delivered");
      expect(await deliveryCount(started.conversationId, "cb-p4")).toBe(1);
      const after = await messageRow(started.conversationId, "evt-p4:reply");
      expect(after?.delivery_status).toBe("delivered");
      expect(after?.delivered_at).not.toBeNull();
      const completed = await operationRow(
        world.applicationId,
        `msgop:delivery-apply:${started.conversationId}:cb-p4`,
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
    });

    test("P5 DELIVERY: crash AFTER the projection move — the restart replays the outcome (no second evidence row)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p5"),
        "start-p5",
        actor,
      );
      await clean.service.ingestInboundEvent(userMessage(started.conversationId, "evt-p5"), actor);
      const dying = world.boot({
        target: "store",
        method: "applyGuardedDeliveryStatusUpdate",
        when: "after",
      });
      const callback = {
        conversationId: started.conversationId,
        messageKey: "evt-p5:reply",
        status: "delivered" as const,
        callbackKey: "cb-p5",
      };
      await diesDuring(() => dying.service.applyDeliveryStatus(callback, actor), dying.crashed);
      // The projection moved; the completion did not.
      const reply = await messageRow(started.conversationId, "evt-p5:reply");
      expect(reply?.delivery_status).toBe("delivered");
      const row = await operationRow(
        world.applicationId,
        `msgop:delivery-apply:${started.conversationId}:cb-p5`,
      );
      expect(row?.status).toBe("pending");
      // RESTART: the replay returns the recorded outcome.
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyDeliveryStatus(callback, actor);
      expect(outcome.replayed).toBe(true);
      expect(outcome.deliveryStatus).toBe("delivered");
      expect(await deliveryCount(started.conversationId, "cb-p5")).toBe(1);
      const completed = await operationRow(
        world.applicationId,
        `msgop:delivery-apply:${started.conversationId}:cb-p5`,
      );
      expect(completed?.status).toBe("completed");
      // The delivery provenance event exists exactly once on the
      // executions ledger.
      const events = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT COUNT(*)::text AS count FROM executions.execution_events
              WHERE execution_id = $1 AND command = 'agent-action-recorded'
                AND payload->>'toStatus' = 'delivered'`,
        parameters: [started.executionId],
      });
      expect(Number(events.rows[0]?.count)).toBe(1);
    });

    test("P6 ESCALATION: crash AFTER the rail-issued checkpoint — the restart completes WITHOUT re-admission and WITHOUT a second rail notice", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p6"),
        "start-p6",
        actor,
      );
      const dying = world.boot({
        target: "store",
        method: "recordMessagingOperationCheckpoint",
        when: "after",
      });
      await diesDuring(
        () =>
          dying.service.escalateToHuman(
            { conversationId: started.conversationId, destination: "support-desk" },
            "esc-p6",
            actor,
          ),
        dying.crashed,
      );
      // The rail notice went out exactly once; the checkpoint survived.
      expect(railRecords(world, "escalate")).toHaveLength(1);
      const row = await operationRow(world.applicationId, "msgop:human-escalation:esc-p6");
      expect(row?.status).toBe("pending");
      const checkpoint = row?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stage).toBe("rail-issued");
      expect(typeof checkpoint?.deliveredAt).toBe("string");
      // No escalation record yet (the crash preceded the insert).
      expect(await escalationCount(started.conversationId, "esc-p6")).toBe(0);
      // RESTART: the durable tail completes from the checkpoint.
      const restarted = world.boot(null);
      const outcome = await restarted.service.escalateToHuman(
        { conversationId: started.conversationId, destination: "support-desk" },
        "esc-p6",
        actor,
      );
      expect(outcome.replayed).toBe(true);
      // No second rail notice, no replay (the rail is never re-called).
      expect(railRecords(world, "escalate")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      const completed = await operationRow(world.applicationId, "msgop:human-escalation:esc-p6");
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      // The governed wait step + the durable record exist exactly once.
      expect(await escalationCount(started.conversationId, "esc-p6")).toBe(1);
      const executionStatus = await ctx.port.execute<{ status: string }>({
        sql: `SELECT status FROM executions.executions WHERE id = $1`,
        parameters: [started.executionId],
      });
      expect(executionStatus.rows[0]?.status).toBe("WAITING_HUMAN");
      expect(await stepEventCount(started.executionId, "wait-human")).toBe(1);
    });

    test("P7 CLOSE: crash AFTER the terminal move — the restart reconciles the PENDING row (the terminal status IS the durable proof)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p7"),
        "start-p7",
        actor,
      );
      const dying = world.boot({
        target: "store",
        method: "applyGuardedConversationMutation",
        when: "after",
      });
      await diesDuring(
        () =>
          dying.service.closeConversation(
            { conversationId: started.conversationId },
            "close-p7",
            actor,
          ),
        dying.crashed,
      );
      // The conversation is terminal in PG; the operation row is PENDING.
      expect(await conversationRow(started.conversationId)).toMatchObject({ status: "closed" });
      const row = await operationRow(world.applicationId, "msgop:conversation-close:close-p7");
      expect(row?.status).toBe("pending");
      expect(railRecords(world, "close")).toHaveLength(1);
      // RESTART: the terminal-status reconciliation completes the op.
      const restarted = world.boot(null);
      const outcome = await restarted.service.closeConversation(
        { conversationId: started.conversationId },
        "close-p7",
        actor,
      );
      expect(outcome.replayed).toBe(true);
      expect(railRecords(world, "close")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      const completed = await operationRow(
        world.applicationId,
        "msgop:conversation-close:close-p7",
      );
      expect(completed?.status).toBe("completed");
      // The completion provenance exists exactly once.
      expect(await stepEventCount(started.executionId, "agent-session-completed")).toBe(1);
      expect(await messageCount(started.conversationId, "close-p7:close")).toBe(1);
    });
  });

  describe("P8: the messaging_operations physical discipline (migration 0020)", () => {
    test("a duplicate durable claim converges on the physical UNIQUE (application, operation_key)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p8a"),
        "start-p8a",
        actor,
      );
      // The completed conversation-start operation: a duplicate claim
      // converges (no second row, no attempts bump on a terminal row).
      const duplicate = await world.messagingStore.beginMessagingOperation({
        operationId: "00000000-0000-7000-8000-0000000000aa",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        conversationId: started.conversationId,
        deploymentId: world.deploymentId,
        executionId: started.executionId,
        operationKind: "conversation-start",
        operationKey: "msgop:conversation-start:start-p8a",
        createdAt: new Date().toISOString(),
      });
      expect(duplicate.status).toBe("existing");
      expect(duplicate.record.status).toBe("completed");
      expect(duplicate.record.attempts).toBe(1);
      const count = await ctx.port.execute<{ count: string }>({
        sql: `SELECT COUNT(*)::text AS count FROM deployments.messaging_operations WHERE operation_key = 'msgop:conversation-start:start-p8a'`,
        parameters: [],
      });
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    test("terminal rows are physically immutable, attempts never regress, the core never moves, and rows are never deleted", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const clean = world.boot(null);
      const started = await clean.service.startConversation(
        startInput(world, "p8b"),
        "start-p8b",
        actor,
      );
      const key = "msgop:conversation-start:start-p8b";
      const row = await operationRow(world.applicationId, key);
      expect(row?.status).toBe("completed");
      const id = row?.id as string;
      // A physical UPDATE of a terminal row is unrepresentable.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_operations SET failure_reason = 'x' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrow(/terminal-immutable/);
      // The write-once identity core never moves.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_operations SET operation_key = 'moved' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrow(/identity core is immutable/);
      // Rows are never deleted.
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.messaging_operations WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrow(/never deleted/);
      // A PENDING row's attempts never regress (monotonic retry ledger).
      const pending = await world.messagingStore.beginMessagingOperation({
        operationId: "00000000-0000-7000-8000-0000000000bb",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        conversationId: started.conversationId,
        deploymentId: world.deploymentId,
        executionId: started.executionId,
        operationKind: "conversation-close",
        operationKey: "msgop:conversation-close:regress-p8b",
        createdAt: new Date().toISOString(),
      });
      expect(pending.status).toBe("begun");
      const pendingId = pending.record.id;
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_operations SET attempts = 0 WHERE id = $1`,
          parameters: [pendingId],
        }),
      ).rejects.toThrow(/cannot move from status|attempts/);
      // The store method rejects a checkpoint write on a terminal row.
      await expect(
        world.messagingStore.recordMessagingOperationCheckpoint(
          world.applicationId,
          key,
          { stage: "rail-issued" },
          new Date().toISOString(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      // A failed operation cannot be completed (the recorded terminal
      // failure outcome is the truth a retry replays).
      await world.messagingStore.failMessagingOperation(
        world.applicationId,
        "msgop:conversation-close:regress-p8b",
        "fixture refusal",
        new Date().toISOString(),
      );
      await expect(
        world.messagingStore.completeMessagingOperation(
          world.applicationId,
          "msgop:conversation-close:regress-p8b",
          new Date().toISOString(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      const failed = await operationRow(
        world.applicationId,
        "msgop:conversation-close:regress-p8b",
      );
      expect(failed?.status).toBe("failed");
      expect(failed?.failure_reason).toBe("fixture refusal");
    });

    test("the vocabulary is enforced physically (kind/status CHECKs, outcome-field exclusivity)", async () => {
      const world = await freshWorld();
      // The kind vocabulary CHECK rejects an unknown operation kind.
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.messaging_operations (
            id, application_id, tenant_id, conversation_id, deployment_id, execution_id,
            operation_kind, operation_key, status, attempts, checkpoint, failure_reason,
            created_at, updated_at, completed_at)
            VALUES ($1, $2, $3, NULL, $4, NULL, 'rail-hangup', 'msgop:bogus', 'pending', 1, NULL, NULL, now(), now(), NULL)`,
          parameters: [
            "00000000-0000-7000-8000-0000000000cc",
            world.applicationId,
            world.tenantId,
            world.deploymentId,
          ],
        }),
      ).rejects.toThrow(/msg_ops_kind_vocabulary/);
      // The status vocabulary CHECK rejects an unknown status.
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.messaging_operations (
            id, application_id, tenant_id, conversation_id, deployment_id, execution_id,
            operation_kind, operation_key, status, attempts, checkpoint, failure_reason,
            created_at, updated_at, completed_at)
            VALUES ($1, $2, $3, NULL, $4, NULL, 'conversation-close', 'msgop:bogus2', 'running', 1, NULL, NULL, now(), now(), NULL)`,
          parameters: [
            "00000000-0000-7000-8000-0000000000cd",
            world.applicationId,
            world.tenantId,
            world.deploymentId,
          ],
        }),
      ).rejects.toThrow(/msg_ops_status_vocabulary/);
      // A COMPLETED row requires its outcome timestamp; a FAILED row
      // requires its bounded reason (the outcome fields are exclusive).
      const begun = await world.messagingStore.beginMessagingOperation({
        operationId: "00000000-0000-7000-8000-0000000000ce",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        conversationId: null,
        deploymentId: world.deploymentId,
        executionId: null,
        operationKind: "conversation-start",
        operationKey: "msgop:conversation-start:outcome-p8c",
        createdAt: new Date().toISOString(),
      });
      expect(begun.status).toBe("begun");
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_operations SET status = 'completed' WHERE id = $1`,
          parameters: [begun.record.id],
        }),
      ).rejects.toThrow(/cannot move from status/);
    });
  });
});
