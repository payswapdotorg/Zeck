/**
 * Real-PostgreSQL integration — the realtime voice-session fabric
 * (WORK-024, MOD-005/006/007; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, EXECUTION-PROVENANCE,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY).
 *
 * Proves against real PostgreSQL (migrations 0001..0018) with the REAL
 * applications/agents/deployments/executions services, the REAL
 * SqlRealtimeStore, the REAL realtime execution-ledger adapter and the
 * in-process simulated rail:
 *
 *   - migration 0018: tables, guard triggers, the unique
 *     idempotency/channel/tenant constraints;
 *   - session identity binding (tenant + application + deployment +
 *     pinned plan version + Execution identity) with the session-mapped
 *     execution created AND lifecycle-walked to RUNNING through the
 *     executions PUBLIC surface;
 *   - start replay convergence + creation-fingerprint key-reuse
 *     rejection (S7 physical half);
 *   - tenant isolation: cross-tenant/cross-application actors cannot
 *     operate the session; tenant-scoped rows are FK-bound (S1);
 *   - duplicate inbound events converge (one delivery, one evidence,
 *     one execution step event); a same-key/different-body replay
 *     fails closed; N=8 CONCURRENT duplicate turns produce exactly one
 *     side effect (S6);
 *   - reconnect keeps the execution identity and advances the epoch
 *     exactly once; CONCURRENT reattach = first writer wins, the loser
 *     fails closed (S7);
 *   - stale callbacks rejected by the service guard AND the physical
 *     trigger (S9);
 *   - deployment version pinning: promotion moves new sessions only;
 *     rollback never rewrites prior identity; the pin and the execution
 *     identity are physically immutable (S10/S11);
 *   - lifecycle guards: terminal-immutable, no delete, monotonic epoch;
 *     the journal is append-only;
 *   - full-lifecycle provenance rides the REAL executions EventEnvelope
 *     ledger (turn/interruption/transfer/failure) with journal
 *     ledger_sequence linkage; deterministic routes reserve no budget
 *     (MOD-007); a denied paid dispatch leaves a durable denial record
 *     with zero deliveries (journal-then-fail).
 */

import { describe, expect, test } from "vitest";
import { definePgSuite } from "./harness";
import {
  type RealtimePgWorld,
  seedRealtimeWorld,
  startRealtimeSession,
  userTurn,
} from "./realtime-world";

definePgSuite("realtime voice sessions (WORK-024) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<RealtimePgWorld> {
    return seedRealtimeWorld(ctx.port);
  }

  const start = startRealtimeSession;

  // ---- SQL inspection helpers ---------------------------------------------
  async function sessionRow(sessionId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.realtime_sessions WHERE id = $1`,
      parameters: [sessionId],
    });
    return result.rows[0] ?? null;
  }

  async function sessionCount(applicationId: string): Promise<number> {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM deployments.realtime_sessions WHERE application_id = $1`,
      parameters: [applicationId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  async function journalRows(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM deployments.realtime_events WHERE session_id = $1 ORDER BY event_seq`,
      parameters: [sessionId],
    });
    return [...result.rows];
  }

  async function executionRow(executionId: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT id, application_id, tenant_id, status, last_event_sequence
            FROM executions.executions WHERE id = $1`,
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

  /** Every journal row that claims a ledger sequence must match a real envelope. */
  async function danglingLedgerLinks(sessionId: string, executionId: string): Promise<number> {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count
            FROM deployments.realtime_events j
            WHERE j.session_id = $1 AND j.ledger_sequence IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM executions.execution_events e
                WHERE e.execution_id = $2 AND e.sequence = j.ledger_sequence
              )`,
      parameters: [sessionId, executionId],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  // ---- schema (migration 0018) ---------------------------------------------

  describe("schema (migration 0018)", () => {
    test("tables, guard triggers and unique constraints exist", async () => {
      const world = await freshWorld();
      for (const table of ["realtime_sessions", "realtime_events"]) {
        const columns = await world.db.execute({
          sql: `SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'deployments' AND table_name = $1`,
          parameters: [table],
        });
        expect(columns.rows.length).toBeGreaterThan(5);
      }
      const triggers = await world.db.execute<{ trigger_name: string }>({
        sql: `SELECT trigger_name FROM information_schema.triggers
              WHERE event_object_schema = 'deployments' AND event_object_table = $1`,
        parameters: ["realtime_sessions"],
      });
      const sessionTriggers = new Set(triggers.rows.map((row) => String(row.trigger_name)));
      for (const expected of [
        "rt_sessions_core_guard",
        "rt_sessions_lifecycle_guard",
        "rt_sessions_no_delete_guard",
      ]) {
        expect(sessionTriggers.has(expected), `trigger ${expected} must exist`).toBe(true);
      }
      const eventTriggers = await world.db.execute<{ trigger_name: string }>({
        sql: `SELECT trigger_name FROM information_schema.triggers
              WHERE event_object_schema = 'deployments' AND event_object_table = $1`,
        parameters: ["realtime_events"],
      });
      const names = new Set(eventTriggers.rows.map((row) => String(row.trigger_name)));
      for (const expected of ["rt_events_channel_fresh_guard", "rt_events_append_only_guard"]) {
        expect(names.has(expected), `trigger ${expected} must exist`).toBe(true);
      }
      const constraints = await world.db.execute<{ constraint_name: string }>({
        sql: `SELECT constraint_name FROM information_schema.table_constraints
              WHERE table_schema = 'deployments' AND constraint_type = 'UNIQUE'
                AND table_name IN ('realtime_sessions', 'realtime_events')`,
        parameters: [],
      });
      const unique = new Set(constraints.rows.map((row) => String(row.constraint_name)));
      for (const expected of [
        "rt_sessions_key_unique",
        "rt_sessions_channel_unique",
        "rt_events_key_unique",
      ]) {
        expect(unique.has(expected), `unique constraint ${expected} must exist`).toBe(true);
      }
    });
  });

  // ---- session identity (MOD-006 / AC3) -------------------------------------

  describe("session identity binding", () => {
    test("a session is durably bound to tenant+application+deployment+pin+execution", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "identity");
      expect(started.replayed).toBe(false);
      expect(started.pinnedPlanVersion).toBe(1);

      const row = await sessionRow(started.sessionId);
      expect(row).not.toBeNull();
      expect(row?.tenant_id).toBe(world.tenantId);
      expect(row?.application_id).toBe(world.applicationId);
      expect(row?.deployment_id).toBe(world.deploymentId);
      expect(row?.pinned_plan_id).toBe("support-voice-plan");
      expect(Number(row?.pinned_plan_version)).toBe(1);
      expect(row?.status).toBe("live");
      expect(Number(row?.channel_epoch)).toBe(1);
      expect(row?.channel_session_ref).toBe("call-identity");

      // The session maps to a REAL execution, walked to RUNNING through
      // the executions public surface (its ledger holds the lifecycle).
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

      // The journal start row links to the agent-session-started envelope.
      const journal = await journalRows(started.sessionId);
      const startRow = journal.find((event) => event.kind === "session-started");
      expect(startRow).toBeDefined();
      expect(Number(startRow?.ledger_sequence)).toBe(6);
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
      void actor;
    });

    test("a retried start under the same key converges on the SAME identities", async () => {
      const world = await freshWorld();
      const first = await start(world, "replay");
      const second = await start(world, "replay");
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.executionId).toBe(first.executionId);
      expect(second.replayed).toBe(true);
      expect(await sessionCount(world.applicationId)).toBe(1);
      expect(await executionCount(world.applicationId)).toBe(1);
      // The rail saw exactly ONE session open (the replay short-circuits).
      expect(world.rail.deliveries.filter((record) => record.kind === "open")).toHaveLength(1);
    });

    test("key reuse with a different creation body fails closed (fingerprint arbitration)", async () => {
      const world = await freshWorld();
      await start(world, "reuse", { channelSessionRef: "call-a" });
      await expect(start(world, "reuse", { channelSessionRef: "call-b" })).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_REUSED",
      });
      expect(await sessionCount(world.applicationId)).toBe(1);
      expect(await executionCount(world.applicationId)).toBe(1);
    });
  });

  // ---- tenant isolation (S1) --------------------------------------------------

  describe("tenant isolation (S1)", () => {
    test("unauthorized tenants cannot operate another tenant's realtime session", async () => {
      const world = await freshWorld();
      const started = await start(world, "tenant");
      const actor = world.actor();

      // Same application, wrong tenant: the session tenant guard fires.
      const wrongTenant = {
        actorId: "00000000-0000-7000-8000-0000000000e1",
        applicationId: world.applicationId,
        tenantId: "00000000-0000-7000-8000-0000000000e2",
      };
      await expect(
        world.service.ingestInboundEvent(userTurn(started, "evt-x-tenant"), wrongTenant),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

      // Cross-application actor: scope-filtered (not found).
      const crossApp = {
        actorId: "00000000-0000-7000-8000-0000000000e3",
        applicationId: "00000000-0000-7000-8000-0000000000e4",
        tenantId: "00000000-0000-7000-8000-0000000000e5",
      };
      await expect(
        world.service.ingestInboundEvent(userTurn(started, "evt-x-tenant"), crossApp),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

      // Starting a session with another tenant's actor on this
      // application's deployment: the deployment tenant guard fires.
      await expect(
        world.service.startSession(
          {
            deploymentId: world.deploymentId,
            channelKind: "web",
            channelSessionRef: "call-foreign",
          },
          "start-foreign",
          wrongTenant,
        ),
      ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

      // Zero rail activity from any of the rejected attempts.
      expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
      expect(world.rail.deliveries.filter((record) => record.kind === "open")).toHaveLength(1);
      void actor;
    });

    test("physical: tenant-scoped rows are FK-bound to the (application, tenant) pair", async () => {
      const world = await freshWorld();
      const started = await start(world, "fk");
      const actor = world.actor();
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.realtime_events (
            id, application_id, tenant_id, session_id, deployment_id, kind, direction, event_key,
            channel_session_ref, channel_epoch, execution_id, ledger_sequence, route_class, cause,
            payload_ref, payload_preview, actor_id, body_digest, created_at)
            VALUES ($1, $2, $3, $4, $5, 'turn-recorded', 'inbound', 'fk-probe', $6, $7, $8, NULL,
                    NULL, NULL, NULL, NULL, $9, 'digest', now())`,
          parameters: [
            started.sessionId, // id (any uuid works; the FK fires first)
            world.applicationId,
            "00000000-0000-7000-8000-0000000000ee", // mismatched tenant
            started.sessionId,
            world.deploymentId,
            started.channelSessionRef,
            started.channelEpoch,
            started.executionId,
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/violates foreign key constraint/);
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.realtime_sessions (
            id, application_id, tenant_id, deployment_id, pinned_plan_id, pinned_plan_version,
            execution_id, channel_kind, channel_session_ref, channel_epoch, caller_ref, status,
            creation_fingerprint, created_by, idempotency_key, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'plan', 1, $5, 'web', 'fk-probe', 1, NULL, 'live', 'fp', $6,
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
    test("a duplicate turn converges: one delivery, one evidence, one execution event", async () => {
      const world = await freshWorld();
      const started = await start(world, "dup");
      const actor = world.actor();

      const first = await world.service.ingestInboundEvent(userTurn(started, "evt-dup"), actor);
      expect(first.replayed).toBe(false);
      const replay = await world.service.ingestInboundEvent(userTurn(started, "evt-dup"), actor);
      expect(replay.replayed).toBe(true);
      expect(replay.eventKey).toBe("evt-dup");
      expect(replay.ledgerSequence).toBe(first.ledgerSequence);

      expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
      expect(world.admissions.responderCalls).toHaveLength(1);
      expect(world.admissions.reserves).toHaveLength(1);

      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row) => row.event_key === "evt-dup")).toHaveLength(1);
      expect(journal.filter((row) => row.event_key === "evt-dup:turn")).toHaveLength(1);

      const events = await ledgerEvents(started.executionId);
      const turnEvents = events.filter(
        (event) => String(event.command) === "agent-action-recorded",
      );
      expect(turnEvents).toHaveLength(1);
      expect(String((turnEvents[0]?.reference as Record<string, unknown>)?.eventKey)).toBe(
        "evt-dup",
      );
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });

    test("a same-key/different-body replay fails closed (poisoned replay)", async () => {
      const world = await freshWorld();
      const started = await start(world, "poison");
      const actor = world.actor();
      await world.service.ingestInboundEvent(userTurn(started, "evt-poison"), actor);
      await expect(
        world.service.ingestInboundEvent(
          { ...userTurn(started, "evt-poison"), payloadPreview: "different body" },
          actor,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      // Still exactly one inbound + one outbound journal row for the key.
      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row) => row.event_key === "evt-poison")).toHaveLength(1);
      expect(journal.filter((row) => row.event_key === "evt-poison:turn")).toHaveLength(1);
    });

    test("CONCURRENT duplicates (N=8): exactly one turn side effect survives", async () => {
      const world = await freshWorld();
      const started = await start(world, "concurrent-dup");
      const actor = world.actor();
      const input = userTurn(started, "evt-concurrent");

      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => world.service.ingestInboundEvent(input, actor)),
      );
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(fulfilled.length).toBe(8);
      const results = fulfilled.map(
        (outcome) => (outcome as PromiseFulfilledResult<{ readonly replayed: boolean }>).value,
      );
      expect(results.filter((result) => result.replayed === false)).toHaveLength(1);
      expect(results.filter((result) => result.replayed === true)).toHaveLength(7);

      // The durable + observable state holds EXACTLY one turn.
      expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
      expect(world.admissions.responderCalls).toHaveLength(1);
      expect(world.admissions.reserves).toHaveLength(1);
      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row) => row.event_key === "evt-concurrent")).toHaveLength(1);
      expect(journal.filter((row) => row.event_key === "evt-concurrent:turn")).toHaveLength(1);
      const events = await ledgerEvents(started.executionId);
      expect(
        events.filter((event) => String(event.command) === "agent-action-recorded"),
      ).toHaveLength(1);
    });
  });

  // ---- reconnect / one execution (S7) -----------------------------------------

  describe("reconnect and single execution identity (S7)", () => {
    test("reattach keeps the identity and advances the epoch exactly once (durable)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "reattach");
      const reattached = await world.service.reattachSession(
        { sessionId: started.sessionId, newChannelSessionRef: `${started.channelSessionRef}-r2` },
        "reattach-1",
        actor,
      );
      expect(reattached.executionId).toBe(started.executionId);
      expect(reattached.channelEpoch).toBe(started.channelEpoch + 1);
      expect(reattached.replayed).toBe(false);

      const row = await sessionRow(started.sessionId);
      expect(row?.status).toBe("live");
      expect(Number(row?.channel_epoch)).toBe(2);
      expect(String(row?.execution_id)).toBe(started.executionId);

      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row) => row.kind === "session-reattached")).toHaveLength(1);

      // Still ONE execution, still RUNNING; the reattach is provenance.
      expect(await executionCount(world.applicationId)).toBe(1);
      const execution = await executionRow(started.executionId);
      expect(execution?.status).toBe("RUNNING");
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });

    test("CONCURRENT reattach: first writer wins, the loser fails closed, epoch moves once", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "reattach-race");
      const outcomes = await Promise.allSettled([
        world.service.reattachSession(
          { sessionId: started.sessionId, newChannelSessionRef: "call-reattach-race-a" },
          "reattach-race-a",
          actor,
        ),
        world.service.reattachSession(
          { sessionId: started.sessionId, newChannelSessionRef: "call-reattach-race-b" },
          "reattach-race-b",
          actor,
        ),
      ]);
      const applied = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(applied.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "INVALID_STATE_TRANSITION",
      });

      const row = await sessionRow(started.sessionId);
      expect(Number(row?.channel_epoch)).toBe(2); // exactly ONE advance
      expect(String(row?.execution_id)).toBe(started.executionId);
      const winnerRef = String(row?.channel_session_ref);
      expect(["call-reattach-race-a", "call-reattach-race-b"]).toContain(winnerRef);

      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row) => row.kind === "session-reattached")).toHaveLength(1);
      expect(await executionCount(world.applicationId)).toBe(1);
    });

    test("CONCURRENT session starts (N=8): exactly one session and one execution", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          world.service.startSession(
            {
              deploymentId: world.deploymentId,
              channelKind: "web",
              channelSessionRef: "call-race",
              callerRef: "caller-race",
            },
            "start-race",
            actor,
          ),
        ),
      );
      // Every caller either converges on the same identity or fails
      // closed — a second durable identity is unrepresentable.
      const identities = new Set<string>();
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          identities.add(`${outcome.value.sessionId}:${outcome.value.executionId}`);
        } else {
          expect(outcome.reason).toBeInstanceOf(Error);
        }
      }
      expect(identities.size).toBe(1);

      // The durable state: ONE session row, ONE execution row.
      expect(await sessionCount(world.applicationId)).toBe(1);
      expect(await executionCount(world.applicationId)).toBe(1);
      const identity = [...identities][0] ?? "";
      expect(identity).not.toBe("");
      const row = await sessionRow(identity.slice(0, identity.indexOf(":")));
      expect(row?.idempotency_key).toBe("start-race");
      expect(row?.status).toBe("live");
    });
  });

  // ---- stale callbacks (S9) ----------------------------------------------------

  describe("stale callbacks (S9)", () => {
    test("a superseded channel coordinate cannot mutate the session (service + physical)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "stale");
      const oldRef = started.channelSessionRef;
      const reattached = await world.service.reattachSession(
        { sessionId: started.sessionId, newChannelSessionRef: "call-stale-new" },
        "stale-reattach",
        actor,
      );
      expect(reattached.channelSessionRef).toBe("call-stale-new");

      // Service guard: the stale (ref, epoch) is rejected.
      await expect(
        world.service.ingestInboundEvent(
          {
            ...userTurn(started, "evt-stale"),
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

      // Physical guard: the journal insert itself is impossible.
      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.realtime_events (
            id, application_id, tenant_id, session_id, deployment_id, kind, direction, event_key,
            channel_session_ref, channel_epoch, execution_id, ledger_sequence, route_class, cause,
            payload_ref, payload_preview, actor_id, body_digest, created_at)
            VALUES ($1, $2, $3, $4, $5, 'turn-recorded', 'inbound', 'stale-probe', $6, 1, $7, NULL,
                    NULL, NULL, NULL, NULL, $8, 'digest', now())`,
          parameters: [
            started.sessionId,
            world.applicationId,
            world.tenantId,
            started.sessionId,
            world.deploymentId,
            oldRef, // the superseded coordinate
            started.executionId,
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/stale realtime callback rejected/);

      // The stale key never produced a journal row.
      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row) => String(row.event_key).includes("evt-stale"))).toHaveLength(0);
      expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    });

    test("inbound events on a terminal session are rejected (service + physical)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "terminal");
      await world.service.closeSession({ sessionId: started.sessionId }, "close-terminal", actor);

      await expect(
        world.service.ingestInboundEvent(userTurn(started, "evt-after-close"), actor),
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

      await expect(
        ctx.port.execute({
          sql: `INSERT INTO deployments.realtime_events (
            id, application_id, tenant_id, session_id, deployment_id, kind, direction, event_key,
            channel_session_ref, channel_epoch, execution_id, ledger_sequence, route_class, cause,
            payload_ref, payload_preview, actor_id, body_digest, created_at)
            VALUES ($1, $2, $3, $4, $5, 'turn-recorded', 'inbound', 'terminal-probe', $6, $7, $8,
                    NULL, NULL, NULL, NULL, NULL, $9, 'digest', now())`,
          parameters: [
            started.sessionId,
            world.applicationId,
            world.tenantId,
            started.sessionId,
            world.deploymentId,
            started.channelSessionRef,
            started.channelEpoch,
            started.executionId,
            actor.actorId,
          ],
        }),
      ).rejects.toThrowError(/inbound events are rejected/);
    });
  });

  // ---- version pinning + rollback (S10/S11) ------------------------------------

  describe("version pinning and rollback (S10/S11)", () => {
    test("promotion moves NEW sessions only; live sessions keep their pin and identity", async () => {
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

      // The live v1 session keeps its ORIGINAL pin (durable).
      const v1Row = await sessionRow(v1.sessionId);
      expect(Number(v1Row?.pinned_plan_version)).toBe(1);

      // The live v1 session still ingests turns on its ORIGINAL pin and
      // the provenance records the pinned version.
      await world.service.ingestInboundEvent(userTurn(v1, "evt-pin-v1"), actor);
      const events = await ledgerEvents(v1.executionId);
      const turn = events.find((event) => String(event.command) === "agent-action-recorded");
      expect(Number((turn?.reference as Record<string, unknown>)?.pinnedPlanVersion)).toBe(1);
    });

    test("rollback does not rewrite prior execution identity (durable, physical)", async () => {
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

      // Prior sessions' pins + execution identities are unchanged.
      const v1Row = await sessionRow(v1.sessionId);
      const v2Row = await sessionRow(v2.sessionId);
      expect(Number(v1Row?.pinned_plan_version)).toBe(1);
      expect(Number(v2Row?.pinned_plan_version)).toBe(2);
      expect(String(v1Row?.execution_id)).toBe(v1.executionId);
      expect(String(v2Row?.execution_id)).toBe(v2.executionId);
      expect(await executionCount(world.applicationId)).toBe(3);

      // Physical: the pin and the execution identity never move.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_sessions SET pinned_plan_version = 2 WHERE id = $1`,
          parameters: [v1.sessionId],
        }),
      ).rejects.toThrowError(/identity core is immutable/);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_sessions SET execution_id = $2 WHERE id = $1`,
          parameters: [v1.sessionId, "00000000-0000-7000-8000-0000000000ff"],
        }),
      ).rejects.toThrowError(/identity core is immutable/);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_sessions SET idempotency_key = 'hijack' WHERE id = $1`,
          parameters: [v1.sessionId],
        }),
      ).rejects.toThrowError(/identity core is immutable/);
    });
  });

  // ---- physical lifecycle guards -----------------------------------------------

  describe("physical lifecycle guards (migration 0018)", () => {
    test("terminal sessions are immutable, epochs are monotonic, rows never deleted", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "guards");
      const reattached = await world.service.reattachSession(
        { sessionId: started.sessionId, newChannelSessionRef: "call-guards-new" },
        "guards-reattach",
        actor,
      );
      await world.service.closeSession({ sessionId: started.sessionId }, "guards-close", actor);

      // Terminal-immutable.
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_sessions SET status = 'live' WHERE id = $1`,
          parameters: [started.sessionId],
        }),
      ).rejects.toThrowError(/terminal-immutable/);
      // No delete.
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.realtime_sessions WHERE id = $1`,
          parameters: [started.sessionId],
        }),
      ).rejects.toThrowError(/never deleted/);

      // Epoch monotonicity + ref/epoch coupling on a LIVE session.
      const live = await start(world, "guards-live");
      await world.service.reattachSession(
        { sessionId: live.sessionId, newChannelSessionRef: "call-guards-live-2" },
        "guards-live-reattach",
        actor,
      );
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_sessions SET channel_epoch = 1 WHERE id = $1`,
          parameters: [live.sessionId],
        }),
      ).rejects.toThrowError(/channel epoch must not regress/);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_sessions SET channel_session_ref = 'call-hijack' WHERE id = $1`,
          parameters: [live.sessionId],
        }),
      ).rejects.toThrowError(/cannot change channel reference without advancing the epoch/);
      expect(reattached.channelEpoch).toBe(2);
    });

    test("the channel journal is append-only", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "journal");
      await world.service.ingestInboundEvent(userTurn(started, "evt-journal"), actor);
      const journal = await journalRows(started.sessionId);
      expect(journal.length).toBeGreaterThan(1);
      const eventId = String(journal[0]?.id);
      await expect(
        ctx.port.execute({
          sql: `UPDATE deployments.realtime_events SET cause = 'rewritten' WHERE id = $1`,
          parameters: [eventId],
        }),
      ).rejects.toThrowError(/append-only/);
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM deployments.realtime_events WHERE id = $1`,
          parameters: [eventId],
        }),
      ).rejects.toThrowError(/append-only/);
    });
  });

  // ---- full-lifecycle provenance (S8, EXECUTION-PROVENANCE) ---------------------

  describe("full lifecycle provenance (S8)", () => {
    test("turns, interruptions and transfers ride the REAL executions ledger", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "lifecycle");

      // A generative turn (full admission chain + paid dispatch).
      const turn = await world.service.ingestInboundEvent(
        userTurn(started, "evt-life-turn"),
        actor,
      );
      expect(turn.routeClass).toBe("generative");
      expect(world.admissions.reserves).toHaveLength(1);

      // An interruption (provenance only — no dispatch).
      await world.service.ingestInboundEvent(
        {
          sessionId: started.sessionId,
          channelSessionRef: started.channelSessionRef,
          channelEpoch: started.channelEpoch,
          kind: "interruption",
          eventKey: "evt-life-interrupt",
          payloadPreview: "wait—",
        },
        actor,
      );

      // A human transfer (policy-designated, auditable).
      const transfer = await world.service.transferToHuman(
        { sessionId: started.sessionId, destination: "support-desk", cause: "customer escalation" },
        "life-transfer",
        actor,
      );
      expect(transfer.executionId).toBe(started.executionId);

      // The session is terminal-transferred; the execution is in the
      // auditable human-escalation wait.
      const row = await sessionRow(started.sessionId);
      expect(row?.status).toBe("transferred");
      expect(row?.closed_at).not.toBeNull();
      const execution = await executionRow(started.executionId);
      expect(execution?.status).toBe("WAITING_HUMAN");

      // The canonical ledger holds the whole lifecycle: creation walk,
      // session start, turn, interruption, the wait-human transition and
      // the transfer — all on ONE execution identity.
      const events = await ledgerEvents(started.executionId);
      const commands = events.map((event) => String(event.command));
      expect(commands).toContain("wait-human");
      const actions = events.filter((event) => event.command === "agent-action-recorded");
      expect(actions.length).toBeGreaterThanOrEqual(3);
      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row_) => row_.kind === "interruption-recorded").length).toBe(2);
      expect(journal.filter((row_) => row_.kind === "transfer-recorded").length).toBe(1);
      // Every journal ledger_sequence link resolves to a real envelope.
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });

    test("deterministic routes reserve no budget (MOD-007) and are still provenance", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "deterministic");
      world.admissions.routeClass = "deterministic";
      const turn = await world.service.ingestInboundEvent(userTurn(started, "evt-det"), actor);
      expect(turn.routeClass).toBe("deterministic");
      expect(world.admissions.reserves).toHaveLength(0);
      expect(world.admissions.responderCalls).toHaveLength(1);
      expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);

      const journal = await journalRows(started.sessionId);
      const outbound = journal.find((row) => row.event_key === "evt-det:turn");
      expect(outbound?.route_class).toBe("deterministic");
      const events = await ledgerEvents(started.executionId);
      const turnEvent = events.find((event) => String(event.command) === "agent-action-recorded");
      expect(String((turnEvent?.payload as Record<string, unknown>)?.routeClass)).toBe(
        "deterministic",
      );
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });

    test("a rail delivery failure records failure provenance and releases the reservation", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "railfail");
      world.rail.failNextDelivery("simulated transport failure");
      await expect(
        world.service.ingestInboundEvent(userTurn(started, "evt-railfail"), actor),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

      const journal = await journalRows(started.sessionId);
      const failure = journal.find((row) => row.event_key === "evt-railfail:turn");
      expect(failure).toBeDefined();
      expect(failure?.kind).toBe("failure-recorded");
      expect(String(failure?.cause)).toContain("simulated transport failure");
      expect(world.admissions.releases).toHaveLength(1);

      const events = await ledgerEvents(started.executionId);
      expect(
        events.some(
          (event) =>
            String(event.command) === "agent-action-recorded" &&
            String((event.payload as Record<string, unknown>)?.reason) ===
              "simulated transport failure",
        ),
      ).toBe(true);
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });

    test("a denied paid dispatch leaves a durable denial record with zero deliveries", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "budgetdenial");
      world.admissions.failBudget = true;
      await expect(
        world.service.ingestInboundEvent(userTurn(started, "evt-budgetdenial"), actor),
      ).rejects.toThrowError(/budget exhausted/);

      // Zero dispatch side effects, and the denial is DURABLE
      // (journal-then-fail on the channel journal + the ledger).
      expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
      expect(world.admissions.responderCalls).toHaveLength(0);
      const journal = await journalRows(started.sessionId);
      const denial = journal.find((row) => row.event_key === "denial:evt-budgetdenial");
      expect(denial).toBeDefined();
      expect(denial?.kind).toBe("failure-recorded");
      expect(String(denial?.cause)).toContain("BUDGET_EXCEEDED");
      const events = await ledgerEvents(started.executionId);
      expect(
        events.some(
          (event) =>
            String(event.command) === "agent-action-recorded" &&
            String((event.payload as Record<string, unknown>)?.code) === "BUDGET_EXCEEDED",
        ),
      ).toBe(true);
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });

    test("caller hangup closes the session with completion provenance", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const started = await start(world, "hangup");
      const outcome = await world.service.ingestInboundEvent(
        {
          sessionId: started.sessionId,
          channelSessionRef: started.channelSessionRef,
          channelEpoch: started.channelEpoch,
          kind: "caller-hangup",
          eventKey: "evt-hangup",
        },
        actor,
      );
      expect(outcome.kind).toBe("caller-hangup");
      const row = await sessionRow(started.sessionId);
      expect(row?.status).toBe("closed");
      expect(row?.closed_at).not.toBeNull();

      const events = await ledgerEvents(started.executionId);
      expect(events.some((event) => String(event.command) === "agent-session-completed")).toBe(
        true,
      );
      const journal = await journalRows(started.sessionId);
      expect(journal.filter((row_) => row_.kind === "session-completed").length).toBe(2);
      await expect(danglingLedgerLinks(started.sessionId, started.executionId)).resolves.toBe(0);
    });
  });
});
