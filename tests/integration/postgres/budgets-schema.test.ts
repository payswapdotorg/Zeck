/**
 * Real-PostgreSQL: budgets schema constraints (WORK-004, BUD-005/BUD-004;
 * checkpoints IMPLEMENTATION-COMPLETENESS and CONCURRENCY-CRASH-SAFETY).
 *
 * Proves the PHYSICAL invariants of migration 0003 against real
 * PostgreSQL:
 *   * the ledger is append-only — UPDATE and DELETE are rejected by the
 *     trigger, not by convention;
 *   * reservations finalize exactly once — terminal rows are immutable;
 *   * CHECK rejections: negative balances, malformed amounts/month keys,
 *     wallet owner shapes, funding vocabulary, budget scope shapes,
 *     ledger class/direction binding;
 *   * composite-FK anti-ambiguity: cross-tenant rows and cross-application
 *     wallet draws are unrepresentable.
 */

import { expect, test } from "vitest";
import type { DatabasePort } from "../../../src/platform/db/port";
import { type BudgetWorld, generateId, seedBudgetWorld } from "./budgets-world";
import { definePgSuite } from "./harness";

definePgSuite("budgets schema constraints (real PG)", (ctx) => {
  let world: BudgetWorld;

  async function insertWallet(db: DatabasePort, overrides: Record<string, unknown>) {
    return db.execute({
      sql: `INSERT INTO budgets.wallets (id, application_id, tenant_id, owner_kind, owner_id, balance_micro_usd)
VALUES ($1, $2, $3, $4, $5, $6)`,
      parameters: [
        (overrides.id as string) ?? generateId(),
        (overrides.applicationId as string) ?? world.applicationId,
        (overrides.tenantId as string) ?? world.tenantId,
        (overrides.ownerKind as string) ?? "developer",
        (overrides.ownerId as string) ?? "",
        (overrides.balance as string) ?? "0",
      ],
    });
  }

  async function insertReservation(db: DatabasePort, overrides: Record<string, unknown>) {
    return db.execute({
      sql: `INSERT INTO budgets.reservations
  (id, application_id, tenant_id, execution_id, operation_id, user_id,
   funding_mode, source_kind, wallet_id, amount_micro_usd, month_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      parameters: [
        (overrides.id as string) ?? generateId(),
        (overrides.applicationId as string) ?? world.applicationId,
        (overrides.tenantId as string) ?? world.tenantId,
        (overrides.executionId as string) ?? "exec-1",
        (overrides.operationId as string) ?? `op-${generateId().slice(-8)}`,
        (overrides.userId as string) ?? "",
        (overrides.fundingMode as string) ?? "developer",
        (overrides.sourceKind as string) ?? "developer",
        (overrides.walletId as string | null) ?? null,
        (overrides.amount as string) ?? "100",
        (overrides.monthKey as string) ?? "2026-03",
      ],
    });
  }

  async function insertLedgerEntry(db: DatabasePort, overrides: Record<string, unknown>) {
    return db.execute({
      sql: `INSERT INTO budgets.ledger_entries
  (id, application_id, tenant_id, wallet_id, reservation_id, entry_class, direction, amount_micro_usd, month_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      parameters: [
        (overrides.id as string) ?? generateId(),
        (overrides.applicationId as string) ?? world.applicationId,
        (overrides.tenantId as string) ?? world.tenantId,
        overrides.walletId as string,
        (overrides.reservationId as string | null) ?? null,
        (overrides.entryClass as string) ?? "credit-grant",
        (overrides.direction as string) ?? "credit",
        (overrides.amount as string) ?? "100",
        (overrides.monthKey as string) ?? "2026-03",
      ],
    });
  }

  test("wallet CHECKs: negative balance, owner shapes, duplicate sources rejected", async () => {
    world = await seedBudgetWorld(ctx.port);
    await expect(insertWallet(ctx.port, { balance: "-1" })).rejects.toThrow(
      /wallets_balance_never_negative/,
    );
    await expect(insertWallet(ctx.port, { ownerKind: "user", ownerId: "" })).rejects.toThrow(
      /wallets_owner_shape/,
    );
    await expect(
      insertWallet(ctx.port, { ownerKind: "developer", ownerId: "someone" }),
    ).rejects.toThrow(/wallets_owner_shape/);
    await expect(insertWallet(ctx.port, { ownerKind: "byok" })).rejects.toThrow(
      /wallets_owner_kind/,
    );
    await insertWallet(ctx.port, { ownerKind: "developer" });
    await expect(insertWallet(ctx.port, { ownerKind: "developer" })).rejects.toThrow(
      /wallets_source_unique/,
    );
  });

  test("funding settings CHECKs: mode vocabulary and composite tenant FK", async () => {
    world = await seedBudgetWorld(ctx.port);
    await expect(
      ctx.port.execute({
        sql: "INSERT INTO budgets.application_funding_settings (application_id, tenant_id, funding_mode) VALUES ($1, $2, $3)",
        parameters: [world.applicationId, world.tenantId, "slush-fund"],
      }),
    ).rejects.toThrow(/funding_mode_vocabulary/);
    // Cross-tenant: tenant id that does not own the application.
    await expect(
      ctx.port.execute({
        sql: "INSERT INTO budgets.application_funding_settings (application_id, tenant_id, funding_mode) VALUES ($1, $2, $3)",
        parameters: [world.applicationId, generateId(), "developer"],
      }),
    ).rejects.toThrow(/funding_settings_tenant_fk/);
  });

  test("budget CHECKs: positive limits and scope shapes", async () => {
    world = await seedBudgetWorld(ctx.port);
    const insert = (scope: string, limit: string, userId: string) =>
      ctx.port.execute({
        sql: `INSERT INTO budgets.budgets (id, application_id, tenant_id, scope_kind, user_id, limit_micro_usd)
VALUES ($1, $2, $3, $4, $5, $6)`,
        parameters: [generateId(), world.applicationId, world.tenantId, scope, userId, limit],
      });
    await expect(insert("monthly", "0", "")).rejects.toThrow(/budgets_limit_positive/);
    await expect(insert("monthly", "-5", "")).rejects.toThrow(/budgets_limit_positive/);
    await expect(insert("user-monthly", "100", "")).rejects.toThrow(/budgets_scope_shape/);
    await expect(insert("per-execution", "100", "user-1")).rejects.toThrow(/budgets_scope_shape/);
    await expect(insert("weekly", "100", "")).rejects.toThrow(/budgets_scope_kind/);
    await insert("monthly", "1000", "");
    await expect(insert("monthly", "2000", "")).rejects.toThrow(/budgets_scope_unique/);
  });

  test("reservation CHECKs: month keys, funding shapes, amounts, terminal immutability", async () => {
    world = await seedBudgetWorld(ctx.port);
    await insertWallet(ctx.port, { ownerKind: "developer" });
    const walletId = await ctx.port
      .execute<{ id: string }>({
        sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
        parameters: [world.applicationId],
      })
      .then((r) => r.rows[0]?.id as string);

    await expect(insertReservation(ctx.port, { walletId, monthKey: "2026-3" })).rejects.toThrow(
      /reservations_month_key_format/,
    );
    await expect(insertReservation(ctx.port, { walletId, monthKey: "2026-13" })).rejects.toThrow(
      /reservations_month_key_format/,
    );
    await expect(insertReservation(ctx.port, { walletId, amount: "0" })).rejects.toThrow(
      /reservations_amount_positive/,
    );
    await expect(insertReservation(ctx.port, { sourceKind: "byok", walletId })).rejects.toThrow(
      /reservations_funding_shape/,
    );
    await expect(
      insertReservation(ctx.port, { sourceKind: "developer", walletId: null }),
    ).rejects.toThrow(/reservations_funding_shape/);
    // One reservation per logical billable operation: a second row for the
    // same (application, operation) is unrepresentable.
    await insertReservation(ctx.port, { walletId, operationId: "op-dup" });
    await expect(insertReservation(ctx.port, { walletId, operationId: "op-dup" })).rejects.toThrow(
      /reservations_operation_unique/,
    );

    // Terminal immutability: a settled reservation can never be re-settled,
    // reset to active or released (the exactly-once physical backstop).
    const reservationId = generateId();
    await insertReservation(ctx.port, { id: reservationId, walletId, operationId: "op-terminal" });
    await ctx.port.execute({
      sql: "UPDATE budgets.reservations SET status = 'settled', settled_amount_micro_usd = 40, finalized_at = now() WHERE id = $1",
      parameters: [reservationId],
    });
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.reservations SET settled_amount_micro_usd = 999 WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/finalize exactly once/);
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.reservations SET status = 'active' WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/finalize exactly once|reservations_finalize_once/);
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.reservations SET status = 'released' WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/finalize exactly once|reservations_finalize_once/);
    // Reservation history is never erased (usage aggregates + ledger
    // linkage must survive).
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM budgets.reservations WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/finalize exactly once|reservations_finalize_once/);
  });

  test("reservation lifecycle shape CHECK: terminal payloads are pinned", async () => {
    world = await seedBudgetWorld(ctx.port);
    const reservationId = generateId();
    await insertReservation(ctx.port, { id: reservationId, sourceKind: "byok", walletId: null });
    // settled without an actual amount is unrepresentable
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.reservations SET status = 'settled', finalized_at = now() WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/reservations_lifecycle_shape|reservations_finalize_once/);
    // active with an actual amount is unrepresentable
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.reservations SET settled_amount_micro_usd = 5 WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/reservations_lifecycle_shape/);
    // released with an actual amount is unrepresentable
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.reservations SET status = 'released', settled_amount_micro_usd = 5, finalized_at = now() WHERE id = $1",
        parameters: [reservationId],
      }),
    ).rejects.toThrow(/reservations_lifecycle_shape/);
  });

  test("composite-FK anti-ambiguity: cross-tenant and cross-application draws are unrepresentable", async () => {
    world = await seedBudgetWorld(ctx.port);
    // A second, unrelated application with its own developer wallet.
    const other = await seedBudgetWorld(ctx.port);
    await insertWallet(ctx.port, {
      applicationId: other.applicationId,
      tenantId: other.tenantId,
      ownerKind: "developer",
      balance: "500",
    });
    const otherWalletId = await ctx.port
      .execute<{ id: string }>({
        sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
        parameters: [other.applicationId],
      })
      .then((r) => r.rows[0]?.id as string);

    // Drawing the OTHER application's wallet from this application's reservation.
    await expect(
      insertReservation(ctx.port, { sourceKind: "developer", walletId: otherWalletId }),
    ).rejects.toThrow(/reservations_wallet_fk|reservations_funding_shape/);
    // A reservation whose tenant disagrees with its application's tenant.
    await expect(
      insertReservation(ctx.port, { tenantId: other.tenantId, sourceKind: "byok" }),
    ).rejects.toThrow(/reservations_tenant_fk/);
    // A ledger entry against the other application's wallet.
    await expect(insertLedgerEntry(ctx.port, { walletId: otherWalletId })).rejects.toThrow(
      /ledger_wallet_fk/,
    );
    // Cross-tenant tenant_id on the ledger itself.
    await insertWallet(ctx.port, { ownerKind: "subsidy" });
    const ownWalletId = await ctx.port
      .execute<{ id: string }>({
        sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'subsidy'",
        parameters: [world.applicationId],
      })
      .then((r) => r.rows[0]?.id as string);
    await expect(
      insertLedgerEntry(ctx.port, { walletId: ownWalletId, tenantId: other.tenantId }),
    ).rejects.toThrow(/ledger_tenant_fk/);
  });

  test("ledger CHECKs: amounts, month keys and class/direction binding", async () => {
    world = await seedBudgetWorld(ctx.port);
    await insertWallet(ctx.port, { ownerKind: "developer", balance: "1000" });
    const walletId = await ctx.port
      .execute<{ id: string }>({
        sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
        parameters: [world.applicationId],
      })
      .then((r) => r.rows[0]?.id as string);

    await expect(insertLedgerEntry(ctx.port, { walletId, amount: "0" })).rejects.toThrow(
      /ledger_amount_positive/,
    );
    await expect(insertLedgerEntry(ctx.port, { walletId, monthKey: "2026-1" })).rejects.toThrow(
      /ledger_month_key_format/,
    );
    // A hold is a DEBIT movement: crediting one is unrepresentable.
    await expect(
      insertLedgerEntry(ctx.port, {
        walletId,
        entryClass: "reservation-hold",
        direction: "credit",
      }),
    ).rejects.toThrow(/ledger_class_direction/);
    await expect(
      insertLedgerEntry(ctx.port, { walletId, entryClass: "credit-grant", direction: "debit" }),
    ).rejects.toThrow(/ledger_class_direction/);
    await expect(
      insertLedgerEntry(ctx.port, { walletId, entryClass: "refund", direction: "credit" }),
    ).rejects.toThrow(/ledger_entry_class|ledger_class_direction/);
  });

  test("APPEND-ONLY LEDGER: UPDATE and DELETE are physically rejected by the trigger", async () => {
    world = await seedBudgetWorld(ctx.port);
    await insertWallet(ctx.port, { ownerKind: "developer", balance: "1000" });
    const walletId = await ctx.port
      .execute<{ id: string }>({
        sql: "SELECT id FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'",
        parameters: [world.applicationId],
      })
      .then((r) => r.rows[0]?.id as string);
    await insertLedgerEntry(ctx.port, { walletId, id: generateId(), amount: "500" });
    const entryId = await ctx.port
      .execute<{ id: string }>({
        sql: "SELECT id FROM budgets.ledger_entries WHERE wallet_id = $1 ORDER BY occurred_at LIMIT 1",
        parameters: [walletId],
      })
      .then((r) => r.rows[0]?.id as string);

    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.ledger_entries SET memo = 'edited', amount_micro_usd = 1 WHERE id = $1",
        parameters: [entryId],
      }),
    ).rejects.toThrow(/ledger_entries is append-only.*UPDATE/s);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM budgets.ledger_entries WHERE id = $1",
        parameters: [entryId],
      }),
    ).rejects.toThrow(/ledger_entries is append-only.*DELETE/s);
    // Even a no-op value UPDATE is rejected: mutation is unrepresentable.
    await expect(
      ctx.port.execute({
        sql: "UPDATE budgets.ledger_entries SET amount_micro_usd = amount_micro_usd WHERE id = $1",
        parameters: [entryId],
      }),
    ).rejects.toThrow(/append-only/);
    // Appending MORE entries stays legal (corrections are new entries).
    await expect(
      insertLedgerEntry(ctx.port, { walletId, entryClass: "correction", direction: "debit" }),
    ).resolves.toBeTruthy();
  });
});
