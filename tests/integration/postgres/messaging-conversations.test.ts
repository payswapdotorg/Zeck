/**
 * Real-PostgreSQL integration — the provider-neutral conversational
 * messaging fabric (WORK-025, MOD-008/009; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, EXECUTION-PROVENANCE,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY).
 *
 * Proves against real PostgreSQL (migrations 0001..0020) with the REAL
 * applications/agents/deployments/executions services, the REAL
 * SqlMessagingStore (migration 0020), the REAL messaging
 * execution-ledger adapter (the executions PUBLIC step-event seam) and
 * the REAL policies engine behind the messaging admission seam, over
 * the in-process simulated rail:
 *
 *   - migration 0020: tables, guard triggers, the unique
 *     idempotency/callback/escalation/operation constraints;
 *   - conversation identity binding (tenant + application + deployment
 *     + PINNED deployment plan version + Execution identity) with the
 *     conversation-mapped execution created AND lifecycle-walked to
 *     RUNNING through the executions PUBLIC surface;
 *   - start replay convergence + creation-fingerprint key-reuse
 *     rejection + N=8 concurrent starts → exactly one identity;
 *   - tenant isolation: cross-tenant/cross-application actors cannot
 *     operate the conversation; tenant-scoped rows are FK-bound (S1);
 *   - duplicate inbound events converge (one send, one reply, one
 *     execution step event); a same-key/different-body replay fails
 *     closed; N=8 CONCURRENT duplicates produce exactly one side
 *     effect (S6);
 *   - the declared per-channel ordering semantics: thread-sequenced
 *     in-order/out-of-order/gap evidence, unordered arrival ordinals
 *     (AC4/S8) — ordering is evidence, never a block;
 *   - delivery callbacks: correlated + idempotent + monotonic
 *     projection; a mismatched rail reference and cross-conversation
 *     mutation are unrepresentable (service + physical trigger); a
 *     stale callback cannot regress the projection (S9);
 *   - admission denials BEFORE the send (journal-then-fail on both
 *     ledgers): the REAL policies engine denying message-send (S2),
 *     missing capability (S3), exhausted budget (S4), refused secret
 *     mediation (S5) — all with zero rail side effects;
 *   - human escalation is a GOVERNED execution step (wait-human →
 *     WAITING_HUMAN, durable record, exactly one rail notice; policy
 *     denial before any side effect) and does NOT close the
 *     conversation (AC7);
 *   - close is terminal with completion provenance; deployment version
 *     pinning: promotion moves new conversations only, rollback never
 *     rewrites prior identity, the pin/execution identity are
 *     physically immutable (S10/S11);
 *   - physical lifecycle guards: terminal-immutable conversations,
 *     append-only message ledger, append-only deliveries, write-once
 *     escalations, no deletes;
 *   - the full inbound → execution → reply → delivery → escalation →
 *     close provenance chain rides the REAL executions EventEnvelope
 *     ledger with ledger_sequence linkage and no dangling links.
 */

import { describe, expect, test } from "vitest";
import { definePgSuite } from "./harness";
import {
  type MessagingPgWorld,
  seedMessagingWorld,
  startMessagingConversation,
  userMessage,
} from "./messaging-world";

definePgSuite("messaging conversations (WORK-025) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<MessagingPgWorld> {
    return seedMessagingWorld(ctx.port);
  }

  const start = startMessagingConversation;

  // ---- SQL inspection helpers ---------------------------------------------
  async function conversationRow(conversationId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_conversations WHERE id = $1`,
      parameters: [conversationId],
    });
    return result.rows[0] ?? null;
  }

  async function conversationCount(applicationId: string): Promise<number> {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.messaging_conversations WHERE application_id = $1`,
      parameters: [applicationId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function messageRows(conversationId: string): Promise<Array<Record<string, unknown>>> {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_messages WHERE conversation_id = $1 ORDER BY event_seq`,
      parameters: [conversationId],
    });
    return [...result.rows];
  }

  async function messageRow(conversationId: string, eventKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_messages WHERE conversation_id = $1 AND event_key = $2`,
      parameters: [conversationId, eventKey],
    });
    return result.rows[0] ?? null;
  }

  async function deliveryRows(conversationId: string): Promise<Array<Record<string, unknown>>> {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_deliveries WHERE conversation_id = $1 ORDER BY event_seq`,
      parameters: [conversationId],
    });
    return [...result.rows];
  }

  async function escalationRows(conversationId: string): Promise<Array<Record<string, unknown>>> {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_escalations WHERE conversation_id = $1`,
      parameters: [conversationId],
    });
    return [...result.rows];
  }

  async function executionRow(executionId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT id, application_id, tenant_id, status FROM executions.executions WHERE id = $1`,
      parameters: [executionId],
    });
    return result.rows[0] ?? null;
  }

  async function executionCount(applicationId: string): Promise<number> {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM executions.executions WHERE application_id = $1`,
      parameters: [applicationId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function ledgerEvents(executionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT sequence, type, command, reference, payload
            FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence`,
      parameters: [executionId],
    });
    return [...result.rows];
  }

  /** Every message/delivery row that claims a ledger sequence must match a real envelope. */
  async function danglingLedgerLinks(conversationId: string, executionId: string): Promise<number> {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count
            FROM deployments.messaging_messages m
            WHERE m.conversation_id = $1 AND m.ledger_sequence IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM executions.execution_events e
                WHERE e.execution_id = $2 AND e.sequence = m.ledger_sequence
              )`,
      parameters: [conversationId, executionId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function operationRow(applicationId: string, operationKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.messaging_operations WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    return result.rows[0] ?? null;
  }

  const railRecords = (world: MessagingPgWorld, kind: string) =>
    world.rail.sends.filter((record) => record.kind === kind);

  // ---- schema (migration 0020) ---------------------------------------------

  describe("schema (migration 0020)", () => {
    test("tables, guard triggers and unique constraints exist", async () => {
      const world = await freshWorld();
      for (const table of [
        "messaging_conversations",
        "messaging_messages",
        "messaging_deliveries",
        "messaging_escalations",
        "messaging_operations",
      ]) {
        const columns = await world.db.execute({
          sql: `SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'deployments' AND table_name = $1`,
          parameters: [table],
        });
        expect(columns.rows.length).toBeGreaterThan(5);
      }
      const expectedTriggers: ReadonlyArray<[string, string]> = [
        ["messaging_conversations", "msg_conversations_core_guard"],
        ["messaging_conversations", "msg_conversations_lifecycle_guard"],
        ["messaging_conversations", "msg_conversations_no_delete_guard"],
        ["messaging_messages", "msg_messages_append_only_guard"],
        ["messaging_messages", "msg_messages_no_delete_guard"],
        ["messaging_messages", "msg_messages_attachments_refs_guard"],
        ["messaging_deliveries", "msg_deliveries_correlated_guard"],
        ["messaging_deliveries", "msg_deliveries_append_only_guard"],
        ["messaging_escalations", "msg_escalations_immutable_guard"],
        ["messaging_operations", "msg_ops_core_guard"],
        ["messaging_operations", "msg_ops_lifecycle_guard"],
        ["messaging_operations", "msg_ops_no_delete_guard"],
      ];
      for (const [table, trigger] of expectedTriggers) {
        const triggers = await world.db.execute<{ trigger_name: string }>({
          sql: `SELECT trigger_name FROM information_schema.triggers
                WHERE event_object_schema = 'deployments' AND event_object_table = $1`,
          parameters: [table],
        });
        const names = new Set(triggers.rows.map((row) => String(row.trigger_name)));
        expect(names.has(trigger), `trigger ${table}.${trigger} must exist`).toBe(true);
      }
      const constraints = await world.db.execute<{ constraint_name: string; table_name: string }>({
        sql: `SELECT constraint_name, table_name FROM information_schema.table_constraints
              WHERE table_schema = 'deployments' AND constraint_type = 'UNIQUE'
                AND table_name LIKE 'messaging_%'`,
        parameters: [],
      });
      const unique = new Set(constraints.rows.map((row) => String(row.constraint_name)));
      for (const expected of [
        "msg_conversations_key_unique",
        "msg_conversations_channel_unique",
        "msg_messages_key_unique",
        "msg_deliveries_key_unique",
        "msg_escalations_key_unique",
        "msg_ops_key_unique",
      ]) {
        expect(unique.has(expected), `unique constraint ${expected} must exist`).toBe(true);
      }
    });
  });

  // ---- conversation identity binding (MOD-009 / AC3) -------------------------

  describe("conversation identity binding", () => {
    test("a conversation is durably bound to tenant+application+deployment+pin+execution", async () => {
      const world = await freshWorld();
      const started = await start(world, "identity");
      expect(started.replayed).toBe(false);
      expect(started.pinnedPlanVersion).toBe(1);
      expect(started.orderingMode).toBe("unordered");
      expect(started.channelConversationRef).toBe("channel-thread-identity");

      const row = await conversationRow(started.conversationId);
      expect(row).not.toBeNull();
      expect(row?.tenant_id).toBe(world.tenantId);
      expect(row?.application_id).toBe(world.applicationId);
      expect(row?.deployment_id).toBe(world.deploymentId);
      expect(row?.pinned_plan_id).toBe("support-chat-plan");
      expect(Number(row?.pinned_plan_version)).toBe(1);
      expect(row?.status).toBe("active");
      expect(row?.channel_kind).toBe("web");
      expect(row?.ordering_mode).toBe("unordered");
      expect(row?.idempotency_key).toBe("start-identity");

      // The conversation maps to a REAL execution, walked to RUNNING
      // through the executions public surface.
      const execution = await executionRow(started.executionId);
      expect(execution).not.toBeNull();
      expect(execution?.tenant_id).toBe(world.tenantId);
      expect(execution?.status).toBe("RUNNING");
      const events = await ledgerEvents(started.executionId);
      const commands = events.map((event) => String(event.command));
      expect(commands).toEqual([
        "create",
        "authorize",
        "plan",
        "queue",
        "start",
        "agent-session-started",
      ]);

      // The start marker row links to the agent-session-started envelope.
      const marker = await messageRow(
        started.conversationId,
        "start-identity:conversation-started",
      );
      expect(marker).not.toBeNull();
      expect(marker?.kind).toBe("system-marker");
      expect(Number(marker?.ledger_sequence)).toBe(6);
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });

    test("a retried start under the same key converges on the SAME identities", async () => {
      const world = await freshWorld();
      const first = await start(world, "replay");
      const second = await start(world, "replay");
      expect(second.conversationId).toBe(first.conversationId);
      expect(second.executionId).toBe(first.executionId);
      expect(second.replayed).toBe(true);
      expect(await conversationCount(world.applicationId)).toBe(1);
      expect(await executionCount(world.applicationId)).toBe(1);
      // The rail saw exactly ONE conversation open (the replay short-circuits).
      expect(railRecords(world, "open")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
    });

    test("key reuse with a different creation body fails closed (fingerprint arbitration)", async () => {
      const world = await freshWorld();
      await start(world, "reuse");
      await expect(
        world.service.startConversation(
          {
            deploymentId: world.deploymentId,
            channelKind: "web",
            channelConversationRef: "channel-thread-different",
          },
          "start-reuse",
          world.actor(),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect(await conversationCount(world.applicationId)).toBe(1);
      expect(await executionCount(world.applicationId)).toBe(1);
    });

    test("CONCURRENT starts (N=8): exactly one conversation and one execution", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          world.service.startConversation(
            {
              deploymentId: world.deploymentId,
              channelKind: "web",
              channelConversationRef: "channel-thread-race",
            },
            "start-race",
            actor,
          ),
        ),
      );
      const identities = new Set<string>();
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          identities.add(`${outcome.value.conversationId}:${outcome.value.executionId}`);
        } else {
          expect(outcome.reason).toBeInstanceOf(Error);
        }
      }
      expect(identities.size).toBe(1);
      expect(await conversationCount(world.applicationId)).toBe(1);
      expect(await executionCount(world.applicationId)).toBe(1);
      expect(railRecords(world, "open")).toHaveLength(1);
    });
  });

  // ---- tenant isolation (S1) --------------------------------------------------

  describe("tenant isolation (S1)", () => {
    test("unauthorized tenants cannot operate another tenant's conversation", async () => {
      const world = await freshWorld();
      const started = await start(world, "tenant");
      const wrongTenant = {
        actorId: "00000000-0000-7000-8000-0000000000e1",
        applicationId: world.applicationId,
        tenantId: "00000000-0000-7000-8000-0000000000e2",
      };
      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-x-tenant"),
          wrongTenant,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      const crossApp = {
        actorId: "00000000-0000-7000-8000-0000000000e3",
        applicationId: "00000000-0000-7000-8000-0000000000e4",
        tenantId: "00000000-0000-7000-8000-0000000000e5",
      };
      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-x-tenant"),
          crossApp,
        ),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
      await expect(
        world.service.startConversation(
          {
            deploymentId: world.deploymentId,
            channelKind: "web",
            channelConversationRef: "channel-thread-foreign",
          },
          "start-foreign",
          wrongTenant,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      await expect(
        world.service.applyDeliveryStatus(
          {
            conversationId: started.conversationId,
            messageKey: "evt-x:reply",
            status: "delivered",
          },
          wrongTenant,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      await expect(
        world.service.escalateToHuman(
          { conversationId: started.conversationId },
          "esc-tenant",
          wrongTenant,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
      await expect(
        world.service.closeConversation(
          { conversationId: started.conversationId },
          "close-tenant",
          wrongTenant,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

      // Zero rail activity from any of the rejected attempts.
      expect(railRecords(world, "send")).toHaveLength(0);
      expect(railRecords(world, "open")).toHaveLength(1);
    });

    test("physical: tenant-scoped rows are FK-bound to the (application, tenant) pair", async () => {
      const world = await freshWorld();
      const started = await start(world, "fk");
      const actor = world.actor();
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.messaging_messages (
            id, application_id, tenant_id, conversation_id, deployment_id, kind, direction, event_key,
            thread_ref, thread_sequence, ordering_marker, execution_id, ledger_sequence, route_class,
            reply_to_event_key, channel_message_ref, delivery_status, delivered_at, cause, payload_ref,
            payload_preview, attachments, actor_id, body_digest, created_at)
            VALUES ($1, $2, $3, $4, $5, 'system-marker', 'internal', 'fk-probe', NULL, NULL, NULL, NULL,
                    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, $6, 'digest', now())`,
          parameters: [
            crypto.randomUUID(),
            world.applicationId,
            "00000000-0000-7000-8000-0000000000ee", // mismatched tenant
            started.conversationId,
            world.deploymentId,
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/violates foreign key constraint/);
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.messaging_conversations (
            id, application_id, tenant_id, deployment_id, pinned_plan_id, pinned_plan_version,
            execution_id, channel_kind, channel_conversation_ref, ordering_mode, participant_ref, status,
            creation_fingerprint, created_by, idempotency_key, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'plan', 1, $5, 'web', 'fk-probe', 'unordered', NULL, 'active', 'fp', $6,
                    'fk-probe-key', now(), now())`,
          parameters: [
            crypto.randomUUID(),
            world.applicationId,
            "00000000-0000-7000-8000-0000000000ef", // mismatched tenant
            world.deploymentId,
            started.executionId,
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/violates foreign key constraint/);
    });
  });

  // ---- duplicate inbound events (S6) -----------------------------------------

  describe("duplicate inbound events (S6)", () => {
    test("a duplicate event converges: one send, one reply, one execution step event", async () => {
      const world = await freshWorld();
      const started = await start(world, "dup");
      const actor = world.actor();

      const first = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-dup"),
        actor,
      );
      expect(first.replayed).toBe(false);
      expect(first.reply?.messageKey).toBe("evt-dup:reply");
      expect(first.reply?.deliveryStatus).toBe("sent");
      const replay = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-dup"),
        actor,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.eventKey).toBe("evt-dup");
      expect(replay.reply?.messageKey).toBe("evt-dup:reply");
      expect(replay.reply?.channelMessageRef).toBe(first.reply?.channelMessageRef);

      expect(railRecords(world, "send")).toHaveLength(1);
      expect(world.admissions.responderCalls).toHaveLength(1);
      expect(world.admissions.reserves).toHaveLength(1);

      const rows = await messageRows(started.conversationId);
      expect(rows.filter((row) => row.event_key === "evt-dup")).toHaveLength(1);
      expect(rows.filter((row) => row.event_key === "evt-dup:reply")).toHaveLength(1);

      const events = await ledgerEvents(started.executionId);
      const turnEvents = events.filter(
        (event) => String(event.command) === "agent-action-recorded",
      );
      expect(turnEvents).toHaveLength(1);
      expect(String((turnEvents[0]?.reference as Record<string, unknown>)?.eventKey)).toBe(
        "evt-dup",
      );
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });

    test("a same-key/different-body replay fails closed (poisoned replay)", async () => {
      const world = await freshWorld();
      const started = await start(world, "poison");
      const actor = world.actor();
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-poison"),
        actor,
      );
      await expect(
        world.service.ingestInboundEvent(
          {
            ...userMessage(started.conversationId, "evt-poison"),
            payloadPreview: "different body",
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      const rows = await messageRows(started.conversationId);
      expect(rows.filter((row) => row.event_key === "evt-poison")).toHaveLength(1);
      expect(rows.filter((row) => row.event_key === "evt-poison:reply")).toHaveLength(1);
      expect(railRecords(world, "send")).toHaveLength(1);
    });

    test("CONCURRENT duplicates (N=8): exactly one send side effect survives", async () => {
      const world = await freshWorld();
      const started = await start(world, "concurrent-dup");
      const actor = world.actor();
      const input = userMessage(started.conversationId, "evt-concurrent");

      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => world.service.ingestInboundEvent(input, actor)),
      );
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(fulfilled.length).toBe(8);
      const results = fulfilled.map(
        (outcome) => (outcome as PromiseFulfilledResult<{ readonly replayed: boolean }>).value,
      );
      expect(results.some((result) => result.replayed === false)).toBe(true);

      // The durable + observable state holds EXACTLY one turn side
      // effect (the stable rail send key converges; the message ledger
      // and the executions ledger each carry exactly one row).
      expect(railRecords(world, "send")).toHaveLength(1);
      const rows = await messageRows(started.conversationId);
      expect(rows.filter((row) => row.event_key === "evt-concurrent")).toHaveLength(1);
      expect(rows.filter((row) => row.event_key === "evt-concurrent:reply")).toHaveLength(1);
      const events = await ledgerEvents(started.executionId);
      expect(
        events.filter((event) => String(event.command) === "agent-action-recorded"),
      ).toHaveLength(1);
      // Every re-consultation carries the SAME stable convergence keys
      // (the responder's turnKey; the budget's operationId), so the
      // seams' own idempotency contracts bound them to one paid effect.
      expect(world.admissions.responderCalls.length).toBeGreaterThanOrEqual(1);
      expect(new Set(world.admissions.responderCalls.map((call) => call.turnKey)).size).toBe(1);
      expect(world.admissions.reserves.length).toBeGreaterThanOrEqual(1);
      expect(new Set(world.admissions.reserves.map((call) => call.operationId)).size).toBe(1);
      // The converged operation row: ONE durable claim, PENDING is
      // resumed to COMPLETED, attempts is the honest retry ledger.
      const operation = await operationRow(
        world.applicationId,
        `msgop:turn-reply:${started.conversationId}:evt-concurrent`,
      );
      expect(operation?.status).toBe("completed");
      expect(Number(operation?.attempts)).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- ordering semantics (AC4 / S8) ------------------------------------------

  describe("ordering semantics (the declared channel contract)", () => {
    test("thread-sequenced: in-order, gap and out-of-order markers are deterministic evidence (never a block)", async () => {
      const world = await freshWorld();
      const started = await start(world, "seq", { orderingMode: "thread-sequenced" });
      const actor = world.actor();

      const first = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-seq-1", { threadRef: "t-1", threadSequence: 1 }),
        actor,
      );
      expect(first.orderingMarker).toBe("in-order");
      const third = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-seq-3", { threadRef: "t-1", threadSequence: 3 }),
        actor,
      );
      expect(third.orderingMarker).toBe("gap");
      const second = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-seq-2", { threadRef: "t-1", threadSequence: 2 }),
        actor,
      );
      expect(second.orderingMarker).toBe("out-of-order");
      // Every out-of-order event still produced its governed reply
      // (ordering is evidence, never a dispatch decision).
      expect(railRecords(world, "send")).toHaveLength(3);

      const rows = await messageRows(started.conversationId);
      const markerOf = (key: string) => {
        const row = rows.find((candidate) => candidate.event_key === key);
        return { marker: String(row?.ordering_marker), sequence: Number(row?.thread_sequence) };
      };
      expect(markerOf("evt-seq-1")).toEqual({ marker: "in-order", sequence: 1 });
      expect(markerOf("evt-seq-3")).toEqual({ marker: "gap", sequence: 3 });
      expect(markerOf("evt-seq-2")).toEqual({ marker: "out-of-order", sequence: 2 });
      // A duplicate replays the COMMITTED marker (deterministic).
      const replay = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-seq-3", { threadRef: "t-1", threadSequence: 3 }),
        actor,
      );
      expect(replay.orderingMarker).toBe("gap");
      expect(replay.replayed).toBe(true);
    });

    test("unordered: the fabric assigns the deterministic arrival ordinal (no assumed global order)", async () => {
      const world = await freshWorld();
      const started = await start(world, "unord", { orderingMode: "unordered" });
      const actor = world.actor();
      for (const key of ["evt-unord-1", "evt-unord-2", "evt-unord-3"]) {
        const outcome = await world.service.ingestInboundEvent(
          userMessage(started.conversationId, key, { threadRef: "t-a" }),
          actor,
        );
        expect(outcome.orderingMarker).toBe("assigned");
      }
      const rows = await messageRows(started.conversationId);
      const arrivals = rows
        .filter((row) => String(row.kind) === "user-message")
        .map((row) => Number(row.thread_sequence));
      expect(arrivals).toEqual([1, 2, 3]);
      // A deterministic-substitute event key: no upstream id, the
      // occurrence ordinal arbitrates the identity.
      const derived = await world.service.ingestInboundEvent(
        {
          conversationId: started.conversationId,
          threadRef: "t-b",
          occurrenceOrdinal: 1,
          payloadPreview: "no upstream event id",
        },
        actor,
      );
      expect(derived.eventKey).toBe(`msg-${started.conversationId}-t-b-1`);
      expect(derived.orderingMarker).toBe("assigned");
    });
  });

  // ---- delivery callbacks (AC6 / S9) ------------------------------------------

  describe("delivery callbacks (correlation + idempotency + monotonic projection)", () => {
    test("a callback applies the forward projection, the evidence row and the provenance", async () => {
      const world = await freshWorld();
      const started = await start(world, "dlv");
      const actor = world.actor();
      await world.service.ingestInboundEvent(userMessage(started.conversationId, "evt-dlv"), actor);
      const replyRow = await messageRow(started.conversationId, "evt-dlv:reply");
      expect(replyRow?.delivery_status).toBe("sent");

      const applied = await world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-dlv:reply",
          status: "delivered",
          detail: "carrier confirmed",
        },
        actor,
      );
      expect(applied.replayed).toBe(false);
      expect(applied.deliveryStatus).toBe("delivered");

      const after = await messageRow(started.conversationId, "evt-dlv:reply");
      expect(after?.delivery_status).toBe("delivered");
      expect(after?.delivered_at).not.toBeNull();
      const deliveries = await deliveryRows(started.conversationId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.callback_key).toBe(
        `dlv-${started.conversationId}-evt-dlv:reply-delivered`,
      );
      expect(String(deliveries[0]?.to_status)).toBe("delivered");

      // Delivery provenance rides the executions ledger (evidence
      // referencing the execution, never a second state machine).
      const events = await ledgerEvents(started.executionId);
      expect(
        events.some(
          (event) =>
            String(event.command) === "agent-action-recorded" &&
            String((event.payload as Record<string, unknown>)?.toStatus) === "delivered",
        ),
      ).toBe(true);
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });

    test("a duplicate callback converges: one evidence row, no second projection move", async () => {
      const world = await freshWorld();
      const started = await start(world, "dlv-dup");
      const actor = world.actor();
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-dlv-dup"),
        actor,
      );
      const input = {
        conversationId: started.conversationId,
        messageKey: "evt-dlv-dup:reply",
        status: "delivered" as const,
        callbackKey: "cb-dlv-dup",
      };
      const first = await world.service.applyDeliveryStatus(input, actor);
      expect(first.replayed).toBe(false);
      const replay = await world.service.applyDeliveryStatus(input, actor);
      expect(replay.replayed).toBe(true);
      expect(replay.deliveryStatus).toBe("delivered");
      const deliveries = await deliveryRows(started.conversationId);
      expect(deliveries).toHaveLength(1);
      const events = await ledgerEvents(started.executionId);
      const deliveryEvents = events.filter(
        (event) =>
          String(event.command) === "agent-action-recorded" &&
          String((event.payload as Record<string, unknown>)?.toStatus) === "delivered",
      );
      expect(deliveryEvents).toHaveLength(1);
    });

    test("a mismatched rail message reference fails closed (the correlation guard, service + physical)", async () => {
      const world = await freshWorld();
      const started = await start(world, "dlv-guard");
      const actor = world.actor();
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-dlv-guard"),
        actor,
      );
      await expect(
        world.service.applyDeliveryStatus(
          {
            conversationId: started.conversationId,
            messageKey: "evt-dlv-guard:reply",
            channelMessageRef: "simmsg-message-999",
            status: "delivered",
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      expect(await deliveryRows(started.conversationId)).toHaveLength(0);

      // Physical: the delivery evidence insert itself is impossible
      // (the correlated-guard trigger).
      const replyRow = await messageRow(started.conversationId, "evt-dlv-guard:reply");
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.messaging_deliveries (
            id, application_id, tenant_id, conversation_id, deployment_id, message_id, execution_id,
            callback_key, channel_message_ref, from_status, to_status, detail, ledger_sequence, actor_id,
            created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'phys-guard', 'simmsg-message-999', 'sent', 'delivered',
                    NULL, NULL, $8, now())`,
          parameters: [
            crypto.randomUUID(),
            world.applicationId,
            world.tenantId,
            started.conversationId,
            world.deploymentId,
            String(replyRow?.id),
            started.executionId,
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/callback correlation violation/);
      // A delivery row referencing another conversation's message is
      // unrepresentable.
      const other = await start(world, "dlv-other");
      await world.service.ingestInboundEvent(
        userMessage(other.conversationId, "evt-dlv-other"),
        world.actor(),
      );
      const otherReply = await messageRow(other.conversationId, "evt-dlv-other:reply");
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.messaging_deliveries (
            id, application_id, tenant_id, conversation_id, deployment_id, message_id, execution_id,
            callback_key, channel_message_ref, from_status, to_status, detail, ledger_sequence, actor_id,
            created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'phys-cross', $8, 'sent', 'delivered', NULL, NULL, $9, now())`,
          parameters: [
            crypto.randomUUID(),
            world.applicationId,
            world.tenantId,
            started.conversationId, // the WRONG conversation
            world.deploymentId,
            String(otherReply?.id), // another conversation's reply
            started.executionId,
            String(otherReply?.channel_message_ref),
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/another conversation|does not match the originating send/);
    });

    test("a STALE callback records its evidence but cannot regress the projection (monotonic vocabulary)", async () => {
      const world = await freshWorld();
      const started = await start(world, "dlv-stale");
      const actor = world.actor();
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-dlv-stale"),
        actor,
      );
      await world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-dlv-stale:reply",
          status: "delivered",
          callbackKey: "cb-terminal",
        },
        actor,
      );
      const terminal = await messageRow(started.conversationId, "evt-dlv-stale:reply");
      expect(terminal?.delivery_status).toBe("delivered");
      const terminalAt = String(terminal?.delivered_at);

      // A late "sent" callback for the same send: evidence YES,
      // projection regression NO (the outcome CONVERGES on the
      // recorded projection).
      const stale = await world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-dlv-stale:reply",
          status: "sent",
          callbackKey: "cb-stale",
        },
        actor,
      );
      expect(stale.replayed).toBe(true);
      expect(stale.deliveryStatus).toBe("delivered");
      const after = await messageRow(started.conversationId, "evt-dlv-stale:reply");
      expect(after?.delivery_status).toBe("delivered");
      expect(String(after?.delivered_at)).toBe(terminalAt);
      const deliveries = await deliveryRows(started.conversationId);
      expect(deliveries).toHaveLength(2);

      // Physical: the terminal delivery status is immutable.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_messages SET delivery_status = 'sent'
                WHERE conversation_id = $1 AND event_key = $2`,
          parameters: [started.conversationId, "evt-dlv-stale:reply"],
        }),
      ).rejects.toThrowError(/terminal-immutable|cannot regress/);
    });

    test("physical: delivery evidence rows are append-only", async () => {
      const world = await freshWorld();
      const started = await start(world, "dlv-ao");
      const actor = world.actor();
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-dlv-ao"),
        actor,
      );
      await world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-dlv-ao:reply",
          status: "delivered",
          callbackKey: "cb-ao",
        },
        actor,
      );
      const deliveries = await deliveryRows(started.conversationId);
      const id = String(deliveries[0]?.id);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_deliveries SET detail = 'rewritten' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrowError(/append-only/);
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.messaging_deliveries WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrowError(/append-only/);
    });
  });

  // ---- admission denials BEFORE the send (S2–S5, AC5) --------------------------

  describe("admission denials before the send (journal-then-fail on both ledgers)", () => {
    test("policy denial (the REAL policies engine) happens BEFORE the send, the responder and the budget", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "deny-policy");
      // Deny the neutral tool dimension for messaging sends (effective
      // for THIS application only).
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          { scope: "platform", selector: {}, restrictions: {} },
          {
            scope: "application",
            selector: { tenantId: world.tenantId, applicationId: world.applicationId },
            restrictions: { tool: { deniedTools: ["messaging:message-send"] } },
          },
        ],
      });

      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-deny-policy"),
          actor,
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(railRecords(world, "send")).toHaveLength(0);
      expect(world.admissions.responderCalls).toHaveLength(0);
      expect(world.admissions.reserves).toHaveLength(0);

      // The denial is DURABLE on both ledgers (journal-then-fail).
      const rows = await messageRows(started.conversationId);
      const denial = rows.find(
        (row) => row.event_key === `denial:${started.conversationId}:evt-deny-policy`,
      );
      expect(denial).toBeDefined();
      expect(String(denial?.cause)).toContain("POLICY_DENIED");
      const events = await ledgerEvents(started.executionId);
      expect(
        events.some(
          (event) =>
            String(event.command) === "agent-action-recorded" &&
            String((event.payload as Record<string, unknown>)?.code) === "POLICY_DENIED",
        ),
      ).toBe(true);
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });

    test("a missing capability cannot send (before the responder and the rail)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "deny-cap");
      world.admissions.unmetCapabilities = ["messaging-conversation"];
      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-deny-cap"),
          actor,
        ),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(railRecords(world, "send")).toHaveLength(0);
      expect(world.admissions.responderCalls).toHaveLength(0);
      const rows = await messageRows(started.conversationId);
      expect(
        rows.some((row) => row.event_key === `denial:${started.conversationId}:evt-deny-cap`),
      ).toBe(true);
    });

    test("a denied budget prevents the paid send (typed, journaled, zero dispatch)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "deny-budget");
      world.admissions.failBudget = true;
      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-deny-budget"),
          actor,
        ),
      ).rejects.toThrowError(/budget exhausted/);
      expect(railRecords(world, "send")).toHaveLength(0);
      expect(world.admissions.responderCalls).toHaveLength(0);
      const rows = await messageRows(started.conversationId);
      const denial = rows.find(
        (row) => row.event_key === `denial:${started.conversationId}:evt-deny-budget`,
      );
      expect(denial).toBeDefined();
      expect(String(denial?.cause)).toContain("BUDGET_EXCEEDED");
      const events = await ledgerEvents(started.executionId);
      expect(
        events.some(
          (event) =>
            String(event.command) === "agent-action-recorded" &&
            String((event.payload as Record<string, unknown>)?.code) === "BUDGET_EXCEEDED",
        ),
      ).toBe(true);
    });

    test("refused secret mediation fails closed (before the send, reservation released)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "deny-secret");
      world.admissions.refuseMediation = true;
      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-deny-secret"),
          actor,
        ),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      expect(railRecords(world, "send")).toHaveLength(0);
      expect(world.admissions.responderCalls).toHaveLength(0);
      // The reservation was released (no leaked hold).
      expect(world.admissions.releases).toHaveLength(1);
      const rows = await messageRows(started.conversationId);
      expect(
        rows.some((row) => row.event_key === `denial:${started.conversationId}:evt-deny-secret`),
      ).toBe(true);
    });

    test("a deterministic route reserves no budget (MOD-007 discipline) and still sends", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "det-route");
      world.admissions.routeClass = "deterministic";
      const turn = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-det-route"),
        actor,
      );
      expect(turn.routeClass).toBe("deterministic");
      expect(world.admissions.reserves).toHaveLength(0);
      expect(railRecords(world, "send")).toHaveLength(1);
      const reply = await messageRow(started.conversationId, "evt-det-route:reply");
      expect(reply?.route_class).toBe("deterministic");
    });
  });

  // ---- human escalation (AC7) --------------------------------------------------

  describe("human escalation (a governed execution step)", () => {
    test("escalation walks the governed wait-human step, notifies the rail exactly once and stays auditable", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "esc");
      const escalated = await world.service.escalateToHuman(
        {
          conversationId: started.conversationId,
          destination: "support-desk",
          cause: "customer frustrated",
        },
        "esc-1",
        actor,
      );
      expect(escalated.escalationKey).toBe("esc-1");
      expect(escalated.destination).toBe("support-desk");
      expect(escalated.ledgerSequence).toBeGreaterThan(0);

      // Exactly ONE upstream escalation notice.
      expect(railRecords(world, "escalate")).toHaveLength(1);

      // The GOVERNED execution step: the execution is WAITING_HUMAN and
      // the ledger carries the wait-human transition.
      const execution = await executionRow(started.executionId);
      expect(execution?.status).toBe("WAITING_HUMAN");
      const events = await ledgerEvents(started.executionId);
      const commands = events.map((event) => String(event.command));
      expect(commands).toContain("wait-human");
      const waitEvent = events.find((event) => String(event.command) === "wait-human");
      // The escalation evidence follows the governed wait step on the
      // same ledger (the agent-action-recorded envelope).
      expect(escalated.ledgerSequence).toBeGreaterThan(Number(waitEvent?.sequence));

      // The durable escalation record binds conversation + execution +
      // the wait linkage.
      const records = await escalationRows(started.conversationId);
      expect(records).toHaveLength(1);
      expect(records[0]?.escalation_key).toBe("esc-1");
      expect(String(records[0]?.execution_id)).toBe(started.executionId);
      expect(records[0]?.notified_at).not.toBeNull();
      expect(Number(records[0]?.wait_sequence)).toBe(Number(waitEvent?.sequence));

      // The marker row (a governed step, not an ad-hoc flag); the
      // conversation stays ACTIVE (async messaging coexistence).
      const marker = await messageRow(started.conversationId, "esc-1:escalation");
      expect(marker?.kind).toBe("system-marker");
      const row = await conversationRow(started.conversationId);
      expect(row?.status).toBe("active");

      // The operation completed durably.
      const operation = await operationRow(world.applicationId, "msgop:human-escalation:esc-1");
      expect(operation?.status).toBe("completed");
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });

    test("idempotent replay under the same key converges on the SAME record (no second notice)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "esc-replay");
      const first = await world.service.escalateToHuman(
        { conversationId: started.conversationId },
        "esc-r1",
        actor,
      );
      const replay = await world.service.escalateToHuman(
        { conversationId: started.conversationId },
        "esc-r1",
        actor,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.escalationKey).toBe(first.escalationKey);
      expect(replay.destination).toBe(first.destination);
      // The replay returns the record's wait linkage (the governed
      // step's durable sequence).
      expect(replay.ledgerSequence).toBeGreaterThan(0);
      expect(railRecords(world, "escalate")).toHaveLength(1);
      expect(world.rail.replays).toHaveLength(0);
      expect(await escalationRows(started.conversationId)).toHaveLength(1);
    });

    test("policy denial of the escalation happens BEFORE the wait step and the rail notice", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "esc-deny");
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          { scope: "platform", selector: {}, restrictions: {} },
          {
            scope: "application",
            selector: { tenantId: world.tenantId, applicationId: world.applicationId },
            restrictions: { tool: { deniedTools: ["messaging:human-escalation"] } },
          },
        ],
      });
      await expect(
        world.service.escalateToHuman(
          { conversationId: started.conversationId },
          "esc-deny-1",
          actor,
        ),
      ).rejects.toMatchObject({ code: "POLICY_DENIED" });
      expect(railRecords(world, "escalate")).toHaveLength(0);
      expect(await escalationRows(started.conversationId)).toHaveLength(0);
      // The execution was NEVER moved to the wait (policy decides first).
      const execution = await executionRow(started.executionId);
      expect(execution?.status).toBe("RUNNING");
      // The denial is durable on both ledgers.
      const rows = await messageRows(started.conversationId);
      expect(rows.some((row) => row.event_key === "denial:esc-deny-1:escalation")).toBe(true);
      const events = await ledgerEvents(started.executionId);
      expect(events.some((event) => String(event.command) === "wait-human")).toBe(false);
      expect(
        events.some(
          (event) =>
            String(event.command) === "agent-action-recorded" &&
            String((event.payload as Record<string, unknown>)?.code) === "POLICY_DENIED",
        ),
      ).toBe(true);
    });

    test("physical: escalation records are write-once", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "esc-wo");
      await world.service.escalateToHuman(
        { conversationId: started.conversationId },
        "esc-wo-1",
        actor,
      );
      const records = await escalationRows(started.conversationId);
      const id = String(records[0]?.id);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_escalations SET destination = 'other' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrowError(/write-once/);
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.messaging_escalations WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrowError(/write-once/);
    });
  });

  // ---- close + version pinning (S10/S11) ---------------------------------------

  describe("close, version pinning and rollback", () => {
    test("close is terminal with completion provenance; replays converge; closed conversations reject new events", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "close");
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-close"),
        actor,
      );
      const closed = await world.service.closeConversation(
        { conversationId: started.conversationId, cause: "customer done" },
        "close-1",
        actor,
      );
      expect(closed.replayed).toBe(false);
      const row = await conversationRow(started.conversationId);
      expect(row?.status).toBe("closed");
      expect(row?.closed_at).not.toBeNull();
      expect(railRecords(world, "close")).toHaveLength(1);
      const events = await ledgerEvents(started.executionId);
      expect(events.some((event) => String(event.command) === "agent-session-completed")).toBe(
        true,
      );
      const marker = await messageRow(started.conversationId, "close-1:close");
      expect(marker).not.toBeNull();

      // The replay under the same key converges (terminal state IS the
      // durable proof).
      const replay = await world.service.closeConversation(
        { conversationId: started.conversationId },
        "close-1",
        actor,
      );
      expect(replay.replayed).toBe(true);
      expect(railRecords(world, "close")).toHaveLength(1);

      // New inbound events on a terminal conversation are rejected.
      await expect(
        world.service.ingestInboundEvent(
          userMessage(started.conversationId, "evt-after-close"),
          actor,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      expect(railRecords(world, "send")).toHaveLength(1);
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });

    test("promotion moves NEW conversations only; live conversations keep their pin and identity", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const v1 = await start(world, "pin-v1");
      expect(v1.pinnedPlanVersion).toBe(1);

      await world.base.deploymentService.promoteDeployment({
        applicationId: world.applicationId,
        deploymentId: world.deploymentId,
        idempotencyKey: "pin-promote",
        actorId: actor.actorId,
        tenantId: world.tenantId,
        toPlanVersion: 2,
      });
      const v2 = await start(world, "pin-v2");
      expect(v2.pinnedPlanVersion).toBe(2);
      expect(v2.executionId).not.toBe(v1.executionId);

      // The live v1 conversation keeps its ORIGINAL pin (durable).
      const v1Row = await conversationRow(v1.conversationId);
      expect(Number(v1Row?.pinned_plan_version)).toBe(1);

      // The live v1 conversation still ingests on its ORIGINAL pin and
      // the provenance records the pinned version.
      await world.service.ingestInboundEvent(userMessage(v1.conversationId, "evt-pin-v1"), actor);
      const events = await ledgerEvents(v1.executionId);
      const turn = events.find((event) => String(event.command) === "agent-action-recorded");
      expect(Number((turn?.reference as Record<string, unknown>)?.pinnedPlanVersion)).toBe(1);
    });

    test("rollback does not rewrite prior identity; the pin and execution are physically immutable", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const v1 = await start(world, "rb-v1");
      await world.base.deploymentService.promoteDeployment({
        applicationId: world.applicationId,
        deploymentId: world.deploymentId,
        idempotencyKey: "rb-promote",
        actorId: actor.actorId,
        tenantId: world.tenantId,
        toPlanVersion: 2,
      });
      const v2 = await start(world, "rb-v2");
      await world.base.deploymentService.rollbackDeployment({
        applicationId: world.applicationId,
        deploymentId: world.deploymentId,
        idempotencyKey: "rb-rollback",
        actorId: actor.actorId,
        tenantId: world.tenantId,
      });
      const v3 = await start(world, "rb-v3");
      expect(v3.pinnedPlanVersion).toBe(1);

      const v1Row = await conversationRow(v1.conversationId);
      const v2Row = await conversationRow(v2.conversationId);
      expect(Number(v1Row?.pinned_plan_version)).toBe(1);
      expect(Number(v2Row?.pinned_plan_version)).toBe(2);
      expect(String(v1Row?.execution_id)).toBe(v1.executionId);
      expect(String(v2Row?.execution_id)).toBe(v2.executionId);
      expect(await executionCount(world.applicationId)).toBe(3);

      // Physical: the pin, the execution identity and the start key
      // never move.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_conversations SET pinned_plan_version = 2 WHERE id = $1`,
          parameters: [v1.conversationId],
        }),
      ).rejects.toThrowError(/identity core is immutable/);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_conversations SET execution_id = $2 WHERE id = $1`,
          parameters: [v1.conversationId, "00000000-0000-7000-8000-0000000000ff"],
        }),
      ).rejects.toThrowError(/identity core is immutable/);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_conversations SET idempotency_key = 'hijack' WHERE id = $1`,
          parameters: [v1.conversationId],
        }),
      ).rejects.toThrowError(/identity core is immutable/);
    });
  });

  // ---- physical lifecycle guards ----------------------------------------------

  describe("physical lifecycle guards (migration 0020)", () => {
    test("terminal conversations are immutable and rows are never deleted", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "guards");
      await world.service.closeConversation(
        { conversationId: started.conversationId },
        "guards-close",
        actor,
      );
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_conversations SET status = 'active' WHERE id = $1`,
          parameters: [started.conversationId],
        }),
      ).rejects.toThrowError(/terminal-immutable/);
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.messaging_conversations WHERE id = $1`,
          parameters: [started.conversationId],
        }),
      ).rejects.toThrowError(/never deleted/);
    });

    test("the message ledger is append-only (except the guarded delivery projection)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "journal");
      await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-journal"),
        actor,
      );
      const rows = await messageRows(started.conversationId);
      expect(rows.length).toBeGreaterThan(2);
      const id = String(rows[0]?.id);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_messages SET cause = 'rewritten' WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrowError(/append-only/);
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.messaging_messages WHERE id = $1`,
          parameters: [id],
        }),
      ).rejects.toThrowError(/never deleted/);
      // An inbound row cannot be mutated into a delivery projection.
      const inbound = rows.find((row) => String(row.event_key) === "evt-journal");
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.messaging_messages SET delivery_status = 'sent'
                WHERE id = $1`,
          parameters: [String(inbound?.id)],
        }),
      ).rejects.toThrowError(/append-only/);
    });
  });

  // ---- full-lifecycle provenance (EXECUTION-PROVENANCE / AC5/AC6) --------------

  describe("full lifecycle provenance (one execution identity)", () => {
    test("the inbound → execution → reply → delivery → escalation → close chain is recorded on the REAL ledger", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "lifecycle");

      // Inbound message → governed reply (full admission chain).
      const turn = await world.service.ingestInboundEvent(
        userMessage(started.conversationId, "evt-life", { threadRef: "thread-9" }),
        actor,
      );
      expect(turn.routeClass).toBe("generative");
      expect(world.admissions.reserves).toHaveLength(1);

      // Delivery callback correlated to the originating send.
      await world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-life:reply",
          status: "delivered",
          callbackKey: "cb-life",
        },
        actor,
      );

      // Human escalation: the governed wait-human step.
      await world.service.escalateToHuman(
        { conversationId: started.conversationId, destination: "support-desk" },
        "esc-life",
        actor,
      );

      // Close: terminal with completion provenance.
      await world.service.closeConversation(
        { conversationId: started.conversationId },
        "close-life",
        actor,
      );

      // The canonical ledger holds the whole lifecycle on ONE
      // execution identity.
      const events = await ledgerEvents(started.executionId);
      const commands = events.map((event) => String(event.command));
      expect(commands).toContain("agent-session-started");
      expect(commands.filter((command) => command === "agent-action-recorded").length).toBe(3);
      expect(commands).toContain("wait-human");
      expect(commands).toContain("agent-session-completed");
      const execution = await executionRow(started.executionId);
      expect(execution?.status).toBe("WAITING_HUMAN");

      // The reply row links back to the inbound event key (the chain).
      const reply = await messageRow(started.conversationId, "evt-life:reply");
      expect(reply?.reply_to_event_key).toBe("evt-life");
      expect(reply?.ledger_sequence).not.toBeNull();
      const delivery = (await deliveryRows(started.conversationId))[0];
      expect(String((delivery as Record<string, unknown>)?.message_id)).toBe(String(reply?.id));

      // No conversation with a second execution was ever created.
      expect(await executionCount(world.applicationId)).toBe(1);
      await expect(danglingLedgerLinks(started.conversationId, started.executionId)).resolves.toBe(
        0,
      );
    });
  });
});
