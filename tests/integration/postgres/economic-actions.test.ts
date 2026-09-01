/**
 * Real-PostgreSQL: economic-action durability (WORK-032; migration 0014;
 * ECO-001..ECO-008 / ADR-0018) — the durable halves of the governed
 * economic-action boundary on REAL PostgreSQL:
 *
 *   * migration 0014 applies on the fresh DB (the five tables, the unique
 *     correlation keys, the physical-invariant triggers);
 *   * durable identity + idempotency through the REAL SQL arbitration
 *     (platform.idempotency_records from 0001 — no second ledger): replay,
 *     key reuse, concurrent duplicate convergence;
 *   * physical write-once identity cores, terminal immutability, no
 *     deletes, append-only evidence tables, gapless per-action event
 *     sequences — rejected by triggers, not by convention;
 *   * bounded authorization durability: one authorization per action, one
 *     per budget reservation operation, single-use consumption, expiry
 *     bounded by the action's own expiry;
 *   * settlement convergence on (application, rail, ref) and append-only
 *     delivery observations;
 *   * THE END-TO-END AUTHORIZE/CHARGE PATH on the REAL budgets SQL
 *     authority (0003): create -> authorize (policy -> capability ->
 *     budget reserve: the hold lands on the real wallet + ledger) ->
 *     charge on the simulated rail (the external side effect AFTER the
 *     durable executing transition) -> budget settle through the real
 *     authority -> settlement correlated -> delivery observation recorded
 *     -> the verification economic-delivery seam reads the SEPARATE axes;
 *     full event ordering on BOTH the per-action journal and the canonical
 *     executions ledger;
 *   * tenant/application isolation on real PG: cross-scope commands fail
 *     closed with zero side effects.
 */

import { expect, test } from "vitest";
import { createSimulatedPaymentRail } from "../../../src/integrations/payment-rails/public";
import {
  createEconomicDeliveryResolver,
  economicDeliveryFacts,
} from "../../../src/modules/verification/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import {
  balanceOf,
  createCommand,
  type EconomicsPgWorld,
  generateId,
  ledgerOf,
  reservationOf,
  scopeOf,
  seedEconomicsWorld,
} from "./economics-world";
import { definePgSuite } from "./harness";

definePgSuite("economic actions durability (real PG)", (ctx) => {
  // -------------------------------------------------------------------------
  // 1. Migration 0014 on the fresh database
  // -------------------------------------------------------------------------

  test("migration 0014 applies: the five economics tables + unique keys + invariant triggers exist", async () => {
    const applied = await ctx.port.execute<{ version: string; name: string }>({
      sql: "SELECT version, name FROM platform.schema_migrations ORDER BY version",
    });
    const appliedNames = applied.rows.map((row) => row.name);
    expect(appliedNames).toContain("economic_actions");

    const tables = await ctx.port.execute<{ table_name: string }>({
      sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'economics' ORDER BY table_name",
    });
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "delivery_observations",
      "economic_action_events",
      "economic_actions",
      "payment_authorizations",
      "settlement_observations",
    ]);

    // The unique keys the durability contract depends on (pg_constraint —
    // the same introspection surface the sibling schema suites use).
    const uniques = await ctx.port.execute<{ conname: string }>({
      sql: "SELECT conname FROM pg_constraint WHERE connamespace = 'economics'::regnamespace AND contype = 'u' ORDER BY conname",
    });
    const uniqueNames = uniques.rows.map((row) => row.conname);
    expect(uniqueNames).toEqual(
      expect.arrayContaining([
        "economic_actions_request_key",
        "economic_actions_scope_key",
        "payment_authorizations_action_key",
        "payment_authorizations_reservation_key",
        "payment_authorizations_scope_key",
        "settlement_observations_convergence_key",
        "economic_action_events_sequence_key",
      ]),
    );

    // The physical-invariant triggers (write-once / lifecycle / no-delete).
    const triggers = await ctx.port.execute<{ tgname: string }>({
      sql: `SELECT tgname FROM pg_trigger
WHERE tgrelid = 'economics.economic_actions'::regclass AND NOT tgisinternal ORDER BY tgname`,
    });
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "economic_actions_immutable_identity_guard",
      "economic_actions_lifecycle_guard",
      "economic_actions_no_delete",
    ]);
    const authTriggers = await ctx.port.execute<{ tgname: string }>({
      sql: `SELECT tgname FROM pg_trigger
WHERE tgrelid = 'economics.payment_authorizations'::regclass AND NOT tgisinternal ORDER BY tgname`,
    });
    expect(authTriggers.rows.map((row) => row.tgname)).toEqual([
      "payment_authorizations_bounded_expiry_guard",
      "payment_authorizations_immutable_constraints_guard",
      "payment_authorizations_lifecycle_guard",
      "payment_authorizations_no_delete",
    ]);
  });

  // -------------------------------------------------------------------------
  // 2. Durable identity + idempotency (real arbitration)
  // -------------------------------------------------------------------------

  test("create is durable and idempotent: same key + same fingerprint replays ONE durable action", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const command = createCommand(world);

    const first = await world.economics.createEconomicAction(command, "create-replay-1");
    expect(first.replayed).toBe(false);
    expect(first.action.status).toBe("proposed");
    expect(first.action.recipient).toEqual({ kind: "merchant", id: "merchant-42" });
    expect(first.action.amount).toEqual({
      kind: "range",
      minMicroUsd: "100000",
      maxMicroUsd: "200000",
    });

    const replay = await world.economics.createEconomicAction(command, "create-replay-1");
    expect(replay.replayed).toBe(true);
    expect(replay.action.id).toBe(first.action.id);
    expect(replay.action.createdAt).toBe(first.action.createdAt);

    const rows = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.economic_actions WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.n).toBe("1");
    const events = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.economic_action_events WHERE economic_action_id = $1",
      parameters: [first.action.id],
    });
    expect(events.rows[0]?.n).toBe("1");
    // Idempotency rides platform.idempotency_records (0001) — no second ledger.
    const ledger = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM platform.idempotency_records WHERE application_id = $1 AND operation_name = 'economics.create-action'",
      parameters: [world.applicationId],
    });
    expect(ledger.rows[0]?.n).toBe("1");
  });

  test("same key + different fingerprint → IDEMPOTENCY_KEY_REUSED with zero durable side effects", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const first = await world.economics.createEconomicAction(
      createCommand(world),
      "create-clash-1",
    );
    // A mutated material constraint is a DIFFERENT logical operation.
    await expect(
      world.economics.createEconomicAction(
        createCommand(world, { amount: { kind: "exact", microUsd: "125000" } }),
        "create-clash-1",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const rows = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.economic_actions WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.n).toBe("1");
    // The execution ledger carries exactly one economic-action-recorded
    // envelope (creation + intent record): the rejected duplicate wrote
    // nothing anywhere.
    const envelopes = await world.executions.listEvents(world.applicationId, world.executionId);
    expect(envelopes.map((e) => e.command)).toEqual(["create", "economic-action-recorded"]);
    expect(await balanceOf(ctx.port, world.walletId)).toBe("1000000");
    expect(first.action.status).toBe("proposed");
  });

  test("concurrent duplicate create converges on a single durable action (real unique arbitration)", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const command = createCommand(world);
    const [a, b] = await Promise.all([
      world.economics.createEconomicAction(command, "create-concurrent-1"),
      world.economics.createEconomicAction(command, "create-concurrent-1"),
    ]);
    expect(a.action.id).toBe(b.action.id);
    // Exactly one fresh insert and one replayed arbitration outcome.
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);

    const rows = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.economic_actions WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.n).toBe("1");
    const events = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.economic_action_events WHERE economic_action_id = $1",
      parameters: [a.action.id],
    });
    expect(events.rows[0]?.n).toBe("1");
    const ledger = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM platform.idempotency_records WHERE application_id = $1 AND idempotency_key = 'create-concurrent-1'",
      parameters: [world.applicationId],
    });
    expect(ledger.rows[0]?.n).toBe("1");
  });

  // -------------------------------------------------------------------------
  // 3. Physical write-once / immutable history (direct SQL against the
  //    durable rows the service produced)
  // -------------------------------------------------------------------------

  test("the action identity/material core is physically immutable; rows are never deleted; the lifecycle is frozen", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const { action } = await world.economics.createEconomicAction(
      createCommand(world),
      "immutable-1",
    );
    const id = action.id;

    const mutate = (column: string, value: string) =>
      ctx.port.execute({
        sql: `UPDATE economics.economic_actions SET ${column} = $2 WHERE id = $1`,
        parameters: [id, value],
      });
    await expect(mutate("recipient_id", "attacker-merchant")).rejects.toThrow(
      /identity and material constraints are immutable/,
    );
    await expect(mutate("amount_max_micro_usd", "999999")).rejects.toThrow(
      /identity and material constraints are immutable/,
    );
    await expect(mutate("purpose", "refund")).rejects.toThrow(
      /identity and material constraints are immutable/,
    );
    await expect(mutate("execution_id", generateId())).rejects.toThrow(
      /identity and material constraints are immutable/,
    );

    // A terminal status is unreachable from proposed through raw SQL (the
    // frozen forward-only lifecycle — only the guarded transitions move it).
    await expect(mutate("status", "settled")).rejects.toThrow(
      /cannot move from status proposed to settled/,
    );

    // Rows are never deleted.
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM economics.economic_actions WHERE id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/economic_actions rows are never deleted/);

    // Terminal immutability: drive proposed -> denied through the legal
    // lifecycle (raw SQL, the trigger-legal transition), then prove the
    // terminal row can never move again.
    await ctx.port.execute({
      sql: "UPDATE economics.economic_actions SET status = 'denied' WHERE id = $1",
      parameters: [id],
    });
    await expect(mutate("status", "proposed")).rejects.toThrow(/terminal-immutable/);
  });

  test("evidence tables are append-only and the per-action event sequence is physically gapless", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const { action } = await world.economics.createEconomicAction(
      createCommand(world),
      "append-only-1",
    );
    const id = action.id;

    // A settlement observation (raw SQL, 13 columns — the durable evidence row).
    await ctx.port.execute({
      sql: `INSERT INTO economics.settlement_observations
  (id, economic_action_id, authorization_id, application_id, tenant_id, rail_id,
   rail_transaction_ref, status, settled_amount_micro_usd, currency, observed_at,
   evidence_digest, recorded_at)
VALUES ($1, $2, NULL, $3, $4, 'rail-x', 'ref-x', 'observed', '100000', 'usd', now(), now()::text, now())`,
      parameters: [generateId(), id, world.applicationId, world.tenantId],
    });
    await expect(
      ctx.port.execute({
        sql: "UPDATE economics.settlement_observations SET status = 'failed' WHERE economic_action_id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/settlement_observations is append-only/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM economics.settlement_observations WHERE economic_action_id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/settlement_observations is append-only/);

    // Delivery observations append and never mutate.
    await world.economics.recordDeliveryObservation(
      {
        ...scopeOf(world),
        economicActionId: id,
        kind: "http-delivery",
        digest: "sha256:delivered-1",
        contentRef: "https://merchant-42.test/receipt/1",
        observedAt: new Date().toISOString(),
      },
      "append-only-delivery-1",
    );
    await world.economics.recordDeliveryObservation(
      {
        ...scopeOf(world),
        economicActionId: id,
        kind: "resource-receipt",
        digest: "sha256:delivered-2",
        contentRef: "https://merchant-42.test/receipt/2",
        observedAt: new Date().toISOString(),
      },
      "append-only-delivery-2",
    );
    const deliveries = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.delivery_observations WHERE economic_action_id = $1",
      parameters: [id],
    });
    expect(deliveries.rows[0]?.n).toBe("2");
    await expect(
      ctx.port.execute({
        sql: "UPDATE economics.delivery_observations SET digest = 'tampered' WHERE economic_action_id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/delivery_observations is append-only/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM economics.delivery_observations WHERE economic_action_id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/delivery_observations is append-only/);

    // The event ledger: append-only + gapless. The action carries 3 events
    // (recorded + 2 deliveries); a gap, a replayed sequence and every
    // mutation/deletion are physically rejected.
    const insertEvent = (sequence: number) =>
      ctx.port.execute({
        sql: `INSERT INTO economics.economic_action_events
  (event_id, economic_action_id, application_id, tenant_id, sequence, type, cause, reference, payload, occurred_at)
VALUES ($1, $2, $3, $4, $5, 'delivery.recorded', 'delivery-evidence', '{}'::jsonb, '{}'::jsonb, now())`,
        parameters: [generateId(), id, world.applicationId, world.tenantId, sequence],
      });
    await expect(insertEvent(5)).rejects.toThrow(/sequence must be gapless per action/);
    await expect(insertEvent(1)).rejects.toThrow(/sequence must be gapless per action/);
    await expect(insertEvent(4)).resolves.toBeTruthy();
    await expect(
      ctx.port.execute({
        sql: "UPDATE economics.economic_action_events SET payload = '{\"forged\": true}'::jsonb WHERE economic_action_id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/economic_action_events is append-only/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM economics.economic_action_events WHERE economic_action_id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/economic_action_events is append-only/);
  });

  // -------------------------------------------------------------------------
  // 4. Bounded authorization durability
  // -------------------------------------------------------------------------

  test("one authorization per action and one per reservation operation; issuance is single-shot through the service", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const created = await world.economics.createEconomicAction(
      createCommand(world),
      "auth-unique-create-1",
    );
    const authorized = await world.economics.authorizeEconomicAction(
      { ...scopeOf(world), economicActionId: created.action.id },
      "auth-unique-auth-1",
    );
    expect(authorized.authorization?.status).toBe("active");
    expect(authorized.authorization?.constraints.maxAmountMicroUsd).toBe("200000");
    // The reservation landed on the REAL budgets ledger (0003).
    const reservation = await reservationOf(ctx.port, `econ-${created.action.id}`);
    expect(reservation?.status).toBe("active");
    expect(reservation?.amount_micro_usd).toBe("200000");
    expect(reservation?.wallet_id).toBe(world.walletId);

    // A second authorization for the SAME action is unrepresentable (unique key).
    await expect(
      insertAuthorizationRow(ctx.port, world, {
        economicActionId: created.action.id,
        reservationOperationId: "econ-manual-second",
      }),
    ).rejects.toThrow(/payment_authorizations_action_key/);

    // A second action cannot carry the FIRST action's reservation operation
    // (double reservation is unrepresentable — ECO-003).
    const second = await world.economics.createEconomicAction(
      createCommand(world),
      "auth-unique-2",
    );
    await expect(
      insertAuthorizationRow(ctx.port, world, {
        economicActionId: second.action.id,
        reservationOperationId: `econ-${created.action.id}`,
      }),
    ).rejects.toThrow(/payment_authorizations_reservation_key/);

    // A second authorize through the service dies on the frozen lifecycle
    // (authorized -> authorized is not a transition) — no second hold.
    await expect(
      world.economics.authorizeEconomicAction(
        { ...scopeOf(world), economicActionId: created.action.id },
        "auth-unique-1-again",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const reservations = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM budgets.reservations WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(reservations.rows[0]?.n).toBe("1");
  });

  test("bounded expiry: an authorization beyond its action's expiry is unrepresentable", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const created = await world.economics.createEconomicAction(createCommand(world), "expiry-1");
    const actionRow = await ctx.port.execute<{ expires_at: Date }>({
      sql: "SELECT expires_at FROM economics.economic_actions WHERE id = $1",
      parameters: [created.action.id],
    });
    const actionExpiry = actionRow.rows[0]?.expires_at as Date;

    // Beyond the action expiry: rejected by the bounded-expiry trigger.
    const beyond = new Date(actionExpiry.getTime() + 60 * 60 * 1000);
    await expect(
      insertAuthorizationRow(ctx.port, world, {
        economicActionId: created.action.id,
        reservationOperationId: "econ-expiry-beyond",
        expiresAt: beyond,
      }),
    ).rejects.toThrow(/payment_authorizations_bounded_expiry|beyond its economic action expiry/);

    // At the action expiry (the boundary itself): representable — an
    // authorization may live exactly as long as its action, never longer.
    await expect(
      insertAuthorizationRow(ctx.port, world, {
        economicActionId: created.action.id,
        reservationOperationId: "econ-expiry-exact",
        expiresAt: actionExpiry,
      }),
    ).resolves.toBeTruthy();
    const authorizations = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.payment_authorizations WHERE economic_action_id = $1",
      parameters: [created.action.id],
    });
    expect(authorizations.rows[0]?.n).toBe("1");
  });

  // -------------------------------------------------------------------------
  // 5. Settlement convergence + correlated evidence only
  // -------------------------------------------------------------------------

  test("duplicate settlement observations converge on ONE durable row; external settlement is evidence only", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const created = await world.economics.createEconomicAction(
      createCommand(world),
      "settlement-1",
    );

    // Store-level convergence (the ON CONFLICT target IS the convergence key).
    const first = await world.store.insertSettlement({
      id: generateId(),
      economicActionId: created.action.id,
      authorizationId: null,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      railId: "rail-conv",
      railTransactionRef: "ref-conv",
      status: "observed",
      settledAmountMicroUsd: "100000",
      currency: "usd",
      observedAt: new Date().toISOString(),
      evidenceDigest: "fnv1a32:aaaaaaaa",
      recordedAt: new Date().toISOString(),
    });
    const duplicate = await world.store.insertSettlement({
      id: generateId(),
      economicActionId: created.action.id,
      authorizationId: null,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      railId: "rail-conv",
      railTransactionRef: "ref-conv",
      status: "confirmed",
      settledAmountMicroUsd: "100000",
      currency: "usd",
      observedAt: new Date().toISOString(),
      evidenceDigest: "fnv1a32:bbbbbbbb",
      recordedAt: new Date().toISOString(),
    });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.status).toBe("observed");
    const rows = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.settlement_observations WHERE rail_id = 'rail-conv'",
      parameters: [],
    });
    expect(rows.rows[0]?.n).toBe("1");

    // Service-level: a DIFFERENT idempotency key for the same external rail
    // transaction converges on the SAME durable observation (fresh work,
    // converged write — never a second row).
    const external = await world.economics.recordExternalSettlement(
      {
        ...scopeOf(world),
        economicActionId: created.action.id,
        railId: "rail-ext",
        railTransactionRef: "ref-ext",
        status: "confirmed",
        settledAmountMicroUsd: "100000",
        currency: "usd",
        observedAt: new Date().toISOString(),
        evidenceDigest: "fnv1a32:cccccccc",
      },
      "external-1",
    );
    expect(external.replayed).toBe(false);
    const externalAgain = await world.economics.recordExternalSettlement(
      {
        ...scopeOf(world),
        economicActionId: created.action.id,
        railId: "rail-ext",
        railTransactionRef: "ref-ext",
        status: "confirmed",
        settledAmountMicroUsd: "100000",
        currency: "usd",
        observedAt: new Date().toISOString(),
        evidenceDigest: "fnv1a32:cccccccc",
      },
      "external-2",
    );
    // The fresh work converged on the existing row (never a duplicate).
    expect(externalAgain.settlement.id).toBe(external.settlement.id);
    expect(externalAgain.settlement.status).toBe(external.settlement.status);

    // CORRELATED EVIDENCE ONLY: the external settlement never moved the
    // action, consumed an authorization or touched the budget authority.
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("proposed");
    expect(await balanceOf(ctx.port, world.walletId)).toBe("1000000");
    const reservations = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM budgets.reservations WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(reservations.rows[0]?.n).toBe("0");
  });

  // -------------------------------------------------------------------------
  // 6. THE END-TO-END AUTHORIZE/CHARGE PATH on the REAL budgets authority
  // -------------------------------------------------------------------------

  test("authorize → charge end to end: real budget reserve/settle on the 0003 ledger, rail settlement correlated, delivery verified, full event ordering", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const command = createCommand(world);

    // -- create: the intent; no money has moved yet.
    const created = await world.economics.createEconomicAction(command, "e2e-create-1");
    const actionId = created.action.id;
    expect(await balanceOf(ctx.port, world.walletId)).toBe("1000000");

    // -- authorize: policy -> capability -> budget reserve -> issuance.
    const authorized = await world.economics.authorizeEconomicAction(
      { ...scopeOf(world), economicActionId: actionId },
      "e2e-auth-1",
    );
    expect(authorized.action.status).toBe("authorized");
    // Both admission authorities were consulted exactly once, in order.
    expect(world.policy.calls.length).toBe(1);
    expect(world.capabilities.calls.length).toBe(1);
    // The hold landed on the REAL budgets ledger: wallet debited, one
    // reservation row for `econ-<actionId>`, append-only hold entry.
    expect(await balanceOf(ctx.port, world.walletId)).toBe("800000");
    const hold = await reservationOf(ctx.port, `econ-${actionId}`);
    expect(hold?.status).toBe("active");
    expect(hold?.amount_micro_usd).toBe("200000");
    expect(await ledgerOf(ctx.port, world.walletId)).toEqual([
      "credit-grant:credit:1000000",
      "reservation-hold:debit:200000",
    ]);

    // -- charge: durable "executing" transition + journal BEFORE the rail
    //    side effect, then budget settle through the real authority.
    const rail = createSimulatedPaymentRail({ railId: "simulated-rail-a" });
    const charged = await world.economics.chargeEconomicAction(
      { ...scopeOf(world), economicActionId: actionId, amountMicroUsd: "150000" },
      rail,
      "e2e-charge-1",
    );
    expect(charged.replayed).toBe(false);
    expect(charged.action.status).toBe("settled");
    expect(charged.authorization.status).toBe("consumed");
    expect(charged.authorization.consumedAt).not.toBeNull();
    expect(charged.settlement.status).toBe("confirmed");
    expect(charged.settlement.settledAmountMicroUsd).toBe("150000");
    expect(charged.settlement.railId).toBe("simulated-rail-a");
    expect(charged.settlement.railTransactionRef).toBe("sim:simulated-rail-a:1");
    expect(charged.settlement.authorizationId).toBe(authorized.authorization?.id);
    // The rail saw exactly one charge: the pinned recipient, the bounded
    // amount, the pinned currency — the substitution firewall held.
    expect(rail.charges.length).toBe(1);
    expect(rail.charges[0]?.amountMicroUsd).toBe("150000");
    expect(rail.charges[0]?.recipient).toEqual({ kind: "merchant", id: "merchant-42" });
    expect(rail.charges[0]?.currency).toBe("usd");
    // The real ledger: hold debited, unused 50000 released on settle.
    expect(await balanceOf(ctx.port, world.walletId)).toBe("850000");
    expect(await ledgerOf(ctx.port, world.walletId)).toEqual([
      "credit-grant:credit:1000000",
      "reservation-hold:debit:200000",
      "settle-release:credit:50000",
    ]);
    const settled = await reservationOf(ctx.port, `econ-${actionId}`);
    expect(settled?.status).toBe("settled");
    expect(settled?.settled_amount_micro_usd).toBe("150000");

    // -- idempotent charge replay: the same key returns the durable outcome
    //    with ZERO further rail side effects or money movement.
    const replayedCharge = await world.economics.chargeEconomicAction(
      { ...scopeOf(world), economicActionId: actionId, amountMicroUsd: "150000" },
      rail,
      "e2e-charge-1",
    );
    expect(replayedCharge.replayed).toBe(true);
    expect(replayedCharge.settlement.id).toBe(charged.settlement.id);
    expect(rail.charges.length).toBe(1);
    expect(await balanceOf(ctx.port, world.walletId)).toBe("850000");

    // -- single-use authorization + terminal action: a second charge fails
    //    closed BEFORE any rail call or budget movement.
    await expect(
      world.economics.chargeEconomicAction(
        { ...scopeOf(world), economicActionId: actionId, amountMicroUsd: "150000" },
        rail,
        "e2e-charge-2",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(rail.charges.length).toBe(1);
    expect(await balanceOf(ctx.port, world.walletId)).toBe("850000");

    // -- delivery observation: evidence recorded AFTER settlement, on the
    //    append-only axis.
    const delivery = await world.economics.recordDeliveryObservation(
      {
        ...scopeOf(world),
        economicActionId: actionId,
        kind: "http-delivery",
        digest: "sha256:receipt-42",
        contentRef: "https://merchant-42.test/receipt/42",
        observedAt: new Date().toISOString(),
      },
      "e2e-delivery-1",
    );
    expect(delivery.replayed).toBe(false);

    // -- the verification seam reads the SEPARATE axes (settlement ≠ delivery).
    const bundle = await world.economics.deliveryEvidence(world.applicationId, actionId);
    expect(bundle?.status).toBe("settled");
    expect(bundle?.settlement?.status).toBe("confirmed");
    expect(bundle?.deliveries.map((row) => row.digest)).toEqual(["sha256:receipt-42"]);
    if (bundle === null) {
      throw new Error("delivery evidence bundle must exist for the settled action");
    }
    const facts = economicDeliveryFacts(bundle);
    expect(facts.settlementStatus).toBe("confirmed");
    expect(facts.settledAmountMicroUsd).toBe("150000");
    expect(facts.deliveryCount).toBe(1);
    expect(facts.deliveryKinds).toEqual(["http-delivery"]);

    const resolver = createEconomicDeliveryResolver(world.economics);
    const resolution = await resolver.resolveTarget({
      tenantId: world.tenantId,
      applicationId: world.applicationId,
      executionId: world.executionId,
      target: { kind: "economic-delivery", ref: actionId },
    });
    expect(resolution).toMatchObject({ resolved: true });
    // Fail-closed: the wrong execution binding or the wrong application
    // scope does not resolve.
    await expect(
      resolver.resolveTarget({
        tenantId: world.tenantId,
        applicationId: world.applicationId,
        executionId: generateId(),
        target: { kind: "economic-delivery", ref: actionId },
      }),
    ).resolves.toMatchObject({ resolved: false });
    await expect(
      resolver.resolveTarget({
        tenantId: world.otherTenantId,
        applicationId: world.otherApplicationId,
        executionId: world.executionId,
        target: { kind: "economic-delivery", ref: actionId },
      }),
    ).resolves.toMatchObject({ resolved: false });

    // -- FULL event ordering on the per-action journal (gapless 1..7).
    const events = await world.economics.listEconomicActionEvents(world.applicationId, actionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((event) => event.type)).toEqual([
      "action.recorded", // 1: intent durably recorded
      "authorization.issued", // 2: after policy -> capability -> budget reserve
      "payment.dispatched", // 3: durable executing transition BEFORE the rail
      "settlement.correlated", // 4: rail observation correlated
      "authorization.consumed", // 5: single use burned
      "settlement.correlated", // 6: terminal settled
      "delivery.recorded", // 7: delivery evidence
    ]);
    expect(events.map((event) => event.cause)).toEqual([
      "economic-intent",
      "platform",
      "rail",
      "rail",
      "platform",
      "rail",
      "delivery-evidence",
    ]);
    // The dispatched event carries the pre-side-effect journal-then-dispatch
    // ordering evidence (rail id + authorization + bounded amount).
    expect(events[2]?.reference).toMatchObject({
      railId: "simulated-rail-a",
      amountMicroUsd: "150000",
    });

    // -- the canonical executions ledger carries the SAME boundary events
    //    (the ECO-007 provenance binding), gapless after creation.
    const envelopes = await world.executions.listEvents(world.applicationId, world.executionId);
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([1, 2, 3, 4]);
    expect(envelopes.map((envelope) => envelope.command)).toEqual([
      "create",
      "economic-action-recorded",
      "economic-action-authorized",
      "economic-action-settled",
    ]);
    expect(envelopes[3]?.reference).toMatchObject({ economicActionId: actionId });
  });

  // -------------------------------------------------------------------------
  // 7. Tenant / application isolation on real PG
  // -------------------------------------------------------------------------

  test("cross-tenant command → TENANT_SCOPE_VIOLATION with zero durable side effects", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const created = await world.economics.createEconomicAction(
      createCommand(world),
      "iso-tenant-1",
    );

    await expect(
      world.economics.authorizeEconomicAction(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.otherTenantId,
          economicActionId: created.action.id,
        },
        "iso-tenant-auth-1",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    // Zero side effects: no authorization, no reservation, no hold, the
    // action untouched, the failed arbitration fully rolled back.
    const authorizations = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM economics.payment_authorizations WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(authorizations.rows[0]?.n).toBe("0");
    const reservations = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM budgets.reservations WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(reservations.rows[0]?.n).toBe("0");
    expect(await balanceOf(ctx.port, world.walletId)).toBe("1000000");
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("proposed");
    const arbitration = await ctx.port.execute<{ n: string }>({
      sql: "SELECT count(*)::text AS n FROM platform.idempotency_records WHERE application_id = $1 AND operation_name = 'economics.authorize-action'",
      parameters: [world.applicationId],
    });
    expect(arbitration.rows[0]?.n).toBe("0");
  });

  test("cross-application command is invisible: tenant-scope failure with zero side effects", async () => {
    const world = await seedEconomicsWorld(ctx.port);
    const created = await world.economics.createEconomicAction(createCommand(world), "iso-app-1");

    // The other application cannot see the action at all.
    expect(
      await world.economics.getEconomicAction(world.otherApplicationId, created.action.id),
    ).toBeNull();

    await expect(
      world.economics.authorizeEconomicAction(
        {
          actorId: world.actorId,
          applicationId: world.otherApplicationId,
          tenantId: world.otherTenantId,
          economicActionId: created.action.id,
        },
        "iso-app-auth-1",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    // Zero side effects in EITHER application's durable state.
    for (const applicationId of [world.applicationId, world.otherApplicationId]) {
      const authorizations = await ctx.port.execute<{ n: string }>({
        sql: "SELECT count(*)::text AS n FROM economics.payment_authorizations WHERE application_id = $1",
        parameters: [applicationId],
      });
      expect(authorizations.rows[0]?.n).toBe("0");
      const reservations = await ctx.port.execute<{ n: string }>({
        sql: "SELECT count(*)::text AS n FROM budgets.reservations WHERE application_id = $1",
        parameters: [applicationId],
      });
      expect(reservations.rows[0]?.n).toBe("0");
    }
    expect(await balanceOf(ctx.port, world.walletId)).toBe("1000000");
    const action = await world.economics.getEconomicAction(world.applicationId, created.action.id);
    expect(action?.status).toBe("proposed");
  });
});

/** Insert a payment authorization row directly (bounded-expiry/unique proofs). */
async function insertAuthorizationRow(
  port: DatabasePort,
  world: EconomicsPgWorld,
  overrides: {
    readonly economicActionId: string;
    readonly reservationOperationId: string;
    readonly expiresAt?: Date;
  },
): Promise<unknown> {
  const issuedAt = new Date(Date.now() - 60 * 1000);
  const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000);
  return port.execute({
    sql: `INSERT INTO economics.payment_authorizations
  (id, economic_action_id, application_id, tenant_id, constraints, status,
   reservation_operation_id, admission_evidence, issued_at, expires_at, consumed_at, created_at)
VALUES ($1, $2, $3, $4, '{}'::jsonb, 'active', $5, '{}'::jsonb, $6, $7, NULL, $6)`,
    parameters: [
      generateId(),
      overrides.economicActionId,
      world.applicationId,
      world.tenantId,
      overrides.reservationOperationId,
      issuedAt,
      expiresAt,
    ],
  });
}
