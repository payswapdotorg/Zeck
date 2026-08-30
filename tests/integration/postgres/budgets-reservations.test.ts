/**
 * Real-PostgreSQL: budget reservations, settlement and idempotency through
 * the FULL SQL fabric (WORK-004, BUD-003/BUD-004/BUD-005; checkpoints
 * IDENTITY-IDEMPOTENCY and CONCURRENCY-CRASH-SAFETY).
 *
 * Proves on real PostgreSQL:
 *   * the funding-mode flows end to end (developer / user / hybrid /
 *     subsidy / byok) with wallet debits and append-only ledger entries;
 *   * idempotent replay (same key replays), key reuse (same key different
 *     request), and same-logical-operation convergence across DIFFERENT
 *     keys (one hold, one debit — never a double hold);
 *   * settle/release exactly-once: convergent double settle/release, the
 *     settle/release invalid-transition rejections, overage/underage
 *     accounting against the live wallet + ledger;
 *   * CRASH-ATOMICITY: a failure anywhere inside the guarded transaction
 *     (mid-work, after the wallet debit) rolls back EVERYTHING — wallet
 *     balance, reservation, ledger entry and the idempotency ledger row
 *     (the retry then succeeds cleanly).
 */

import { expect, test } from "vitest";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import type { BudgetStore } from "../../../src/modules/budgets/ports/budget-store";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR_ID, balanceOf, generateId, seedBudgetWorld, walletIdOf } from "./budgets-world";
import { definePgSuite } from "./harness";

definePgSuite("budgets reservations and settlement (real PG)", (ctx) => {
  test("developer flow: grant, reserve, settle — wallet + ledger agree end to end", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "cfg-1");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "1000000" },
      "grant-1",
    );
    const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");
    expect(await balanceOf(ctx.port, walletId)).toBe("1000000");

    const reserved = await world.service.reserve(
      { ...scope, executionId: "exec-1", operationId: "op-1", amountMicroUsd: "250000" },
      "reserve-1",
    );
    expect(reserved.reservation.sourceKind).toBe("developer");
    expect(reserved.reservation.monthKey).toBe(
      `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`,
    );
    expect(await balanceOf(ctx.port, walletId)).toBe("750000");

    const settled = await world.service.settle(
      { ...scope, operationId: "op-1", actualAmountMicroUsd: "217000" },
      "settle-1",
    );
    expect(settled.reservation.status).toBe("settled");
    expect(settled.reservation.settledAmountMicroUsd).toBe("217000");
    expect(await balanceOf(ctx.port, walletId)).toBe("783000");

    // Ledger = the full money trail; debits - credits equal consumption.
    const entries = await ctx.port.execute<{
      entry_class: string;
      direction: string;
      amount_micro_usd: string;
    }>({
      sql: "SELECT entry_class, direction, amount_micro_usd FROM budgets.ledger_entries WHERE wallet_id = $1 ORDER BY occurred_at, id",
      parameters: [walletId],
    });
    expect(
      entries.rows.map((r) => `${r.entry_class}:${r.direction}:${r.amount_micro_usd}`),
    ).toEqual([
      "credit-grant:credit:1000000",
      "reservation-hold:debit:250000",
      "settle-release:credit:33000",
    ]);
    const net = entries.rows.reduce(
      (acc, r) => acc + BigInt(r.amount_micro_usd) * (r.direction === "debit" ? 1n : -1n),
      0n,
    );
    // credits - debits (the ledger's net) always equals the live balance of
    // a wallet that was funded only through credit-grant entries; the
    // consumption is exactly the settled actual usage.
    expect((-net).toString()).toBe(await balanceOf(ctx.port, walletId));
    expect(1000000n - 217000n).toBe(BigInt(await balanceOf(ctx.port, walletId)));
  });

  test("hybrid flow end to end: user funds drawn first, developer wallet as backstop", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    const USER = "user-42";
    await world.service.configureFundingMode({ ...scope, fundingMode: "hybrid" }, "cfg-h");
    await world.service.grantCredits(
      { ...scope, ownerKind: "user", ownerId: USER, amountMicroUsd: "1000" },
      "grant-hu",
    );
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "100000" },
      "grant-hd",
    );
    const first = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-small", userId: USER, amountMicroUsd: "800" },
      "res-h1",
    );
    expect(first.reservation.sourceKind).toBe("user");
    const second = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-big", userId: USER, amountMicroUsd: "5000" },
      "res-h2",
    );
    expect(second.reservation.sourceKind).toBe("developer");
    expect(
      await balanceOf(ctx.port, await walletIdOf(ctx.port, world.applicationId, "user", USER)),
    ).toBe("200");
    expect(
      await balanceOf(ctx.port, await walletIdOf(ctx.port, world.applicationId, "developer")),
    ).toBe("95000");
  });

  test("byok flow end to end: hold and settle with zero wallet movement", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "byok" }, "cfg-b");
    const reserved = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-byok", amountMicroUsd: "999" },
      "res-byok",
    );
    expect(reserved.reservation.walletId).toBeNull();
    const settled = await world.service.settle(
      { ...scope, operationId: "op-byok", actualAmountMicroUsd: "950" },
      "settle-byok",
    );
    expect(settled.reservation.settledAmountMicroUsd).toBe("950");
    const wallets = await ctx.port.execute({
      sql: "SELECT count(*)::int AS n FROM budgets.wallets WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(wallets.rows[0]?.n).toBe(0);
    const ledger = await ctx.port.execute({
      sql: "SELECT count(*)::int AS n FROM budgets.ledger_entries WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(ledger.rows[0]?.n).toBe(0);
  });

  test("idempotent replay and same-key reuse on real PostgreSQL arbitration", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "cfg-i");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "10000" },
      "grant-i",
    );
    const first = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-replay", amountMicroUsd: "3000" },
      "key-same",
    );
    const replay = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-replay", amountMicroUsd: "3000" },
      "key-same",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    await expect(
      world.service.reserve(
        { ...scope, executionId: "e", operationId: "op-replay", amountMicroUsd: "4000" },
        "key-same",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(
      await balanceOf(ctx.port, await walletIdOf(ctx.port, world.applicationId, "developer")),
    ).toBe("7000");
  });

  test("a DIFFERENT key for the same logical operation converges — one hold, one debit", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "subsidy" }, "cfg-c");
    await world.service.grantCredits(
      { ...scope, ownerKind: "subsidy", amountMicroUsd: "10000" },
      "grant-c",
    );
    await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-conv", amountMicroUsd: "3000" },
      "key-1",
    );
    const converged = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-conv", amountMicroUsd: "3000" },
      "key-2",
    );
    expect(converged.converged).toBe(true);
    expect(converged.replayed).toBe(false);
    const walletId = await walletIdOf(ctx.port, world.applicationId, "subsidy");
    expect(await balanceOf(ctx.port, walletId)).toBe("7000"); // debited exactly once
    const rows = await ctx.port.execute({
      sql: "SELECT count(*)::int AS n FROM budgets.reservations WHERE application_id = $1",
      parameters: [world.applicationId],
    });
    expect(rows.rows[0]?.n).toBe(1);
  });

  test("settle and release exactly-once with convergent replays", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "cfg-s");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "5000" },
      "grant-s",
    );
    await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-settle", amountMicroUsd: "2000" },
      "res-s",
    );
    const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");

    const settled = await world.service.settle(
      { ...scope, operationId: "op-settle", actualAmountMicroUsd: "500" },
      "settle-s",
    );
    expect(settled.reservation.status).toBe("settled");
    const replay = await world.service.settle(
      { ...scope, operationId: "op-settle", actualAmountMicroUsd: "500" },
      "settle-s",
    );
    expect(replay.replayed).toBe(true);
    const converged = await world.service.settle(
      { ...scope, operationId: "op-settle", actualAmountMicroUsd: "500" },
      "settle-s2",
    );
    expect(converged.converged).toBe(true);
    expect(await balanceOf(ctx.port, walletId)).toBe("4500"); // 5000 - 500 actual, exactly once

    await expect(
      world.service.release({ ...scope, operationId: "op-settle" }, "rel-s"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      world.service.settle(
        { ...scope, operationId: "op-settle", actualAmountMicroUsd: "600" },
        "settle-s3",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    // Release path on a fresh operation.
    await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-release", amountMicroUsd: "1000" },
      "res-r",
    );
    const released = await world.service.release({ ...scope, operationId: "op-release" }, "rel-r");
    expect(released.reservation.status).toBe("released");
    const releasedAgain = await world.service.release(
      { ...scope, operationId: "op-release" },
      "rel-r2",
    );
    expect(releasedAgain.converged).toBe(true);
    expect(await balanceOf(ctx.port, walletId)).toBe("4500"); // full hold returned exactly once
    await expect(
      world.service.settle(
        { ...scope, operationId: "op-release", actualAmountMicroUsd: "1" },
        "settle-r",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("overage settlement debits the extra usage; an empty wallet fails closed and stays honest", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "cfg-o");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "1000" },
      "grant-o",
    );
    await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-over", amountMicroUsd: "1000" },
      "res-o",
    );
    await expect(
      world.service.settle(
        { ...scope, operationId: "op-over", actualAmountMicroUsd: "1800" },
        "settle-o",
      ),
    ).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: true,
      details: { reason: "insufficient-funds-at-settlement" },
    });
    const stuck = await world.service.getReservation(world.applicationId, "op-over");
    expect(stuck?.status).toBe("active"); // nothing partial committed
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "5000" },
      "grant-o2",
    );
    const settled = await world.service.settle(
      { ...scope, operationId: "op-over", actualAmountMicroUsd: "1800" },
      "settle-o",
    );
    expect(settled.reservation.status).toBe("settled");
    const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");
    expect(await balanceOf(ctx.port, walletId)).toBe("4200"); // 1000+5000-1800
  });

  test("budget admission on real PG: monthly and per-execution limits bind", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "cfg-bl");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "1000000" },
      "grant-bl",
    );
    await world.service.setBudget(
      { ...scope, scopeKind: "per-execution", limitMicroUsd: "5000" },
      "b1",
    );
    await world.service.setBudget({ ...scope, scopeKind: "monthly", limitMicroUsd: "8000" }, "b2");
    await world.service.reserve(
      { ...scope, executionId: "exec-a", operationId: "op-a1", amountMicroUsd: "3000" },
      "r-a1",
    );
    await expect(
      world.service.reserve(
        { ...scope, executionId: "exec-a", operationId: "op-a2", amountMicroUsd: "3000" },
        "r-a2",
      ),
    ).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { reason: "execution-budget" },
    });
    await world.service.reserve(
      { ...scope, executionId: "exec-b", operationId: "op-b1", amountMicroUsd: "5000" },
      "r-b1",
    );
    await expect(
      world.service.reserve(
        { ...scope, executionId: "exec-c", operationId: "op-c1", amountMicroUsd: "1" },
        "r-c1",
      ),
    ).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { reason: "monthly-budget", committedMicroUsd: "8000" },
    });
  });

  test("CRASH-ATOMICITY: a mid-work failure after the wallet debit rolls back everything", async () => {
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "cfg-crash");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "10000" },
      "grant-crash",
    );
    const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");

    // A store that explodes when appending the hold ledger entry — the
    // failure lands AFTER the reservation insert and the wallet debit.
    class FaultingStore extends SqlBudgetStore {
      override async appendLedgerEntry(...args: Parameters<BudgetStore["appendLedgerEntry"]>) {
        if (args[0].entryClass === "reservation-hold") {
          throw new PlatformError({ code: "SANDBOX_ERROR", message: "injected mid-work crash" });
        }
        return super.appendLedgerEntry(...args);
      }
    }
    const faultingService: BudgetService = createBudgetService({
      store: new SqlBudgetStore(ctx.port),
      idempotency: new SqlBudgetsIdempotency(ctx.port, (tx) => new FaultingStore(tx), generateId),
      generateId,
      now: () => new Date(),
    });

    await expect(
      faultingService.reserve(
        { ...scope, executionId: "e", operationId: "op-crash", amountMicroUsd: "4000" },
        "res-crash",
      ),
    ).rejects.toMatchObject({ code: "SANDBOX_ERROR" });

    // NOTHING from the guarded operation survived — not the hold, not the
    // debit, not the ledger entry, not even the idempotency record.
    expect(await balanceOf(ctx.port, walletId)).toBe("10000");
    expect(await world.service.getReservation(world.applicationId, "op-crash")).toBeNull();
    const counts = await ctx.port.execute<{
      reservations: number;
      holds: number;
      idempotency: number;
    }>({
      sql: `SELECT
  (SELECT count(*)::int FROM budgets.reservations WHERE application_id = $1 AND operation_id = 'op-crash') AS reservations,
  (SELECT count(*)::int FROM budgets.ledger_entries WHERE application_id = $1 AND entry_class = 'reservation-hold') AS holds,
  (SELECT count(*)::int FROM platform.idempotency_records WHERE application_id = $1 AND idempotency_key = 'res-crash') AS idempotency`,
      parameters: [world.applicationId],
    });
    const row = counts.rows[0];
    expect(row?.reservations).toBe(0);
    expect(row?.holds).toBe(0);
    expect(row?.idempotency).toBe(0);

    // The retry (same key) succeeds cleanly — crash recovery is a plain retry.
    const retried = await world.service.reserve(
      { ...scope, executionId: "e", operationId: "op-crash", amountMicroUsd: "4000" },
      "res-crash",
    );
    expect(retried.replayed).toBe(false);
    expect(retried.reservation.status).toBe("active");
    expect(await balanceOf(ctx.port, walletId)).toBe("6000");
  });
});
