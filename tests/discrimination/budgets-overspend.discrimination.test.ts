/**
 * Discrimination: CONCURRENT overspend boundaries (WORK-004, BUD-004;
 * checkpoint CONCURRENCY-CRASH-SAFETY; acceptance criterion 6).
 *
 * Mutation proofs against REAL PostgreSQL — each mutant is the shipped
 * SqlBudgetStore with exactly one protection removed:
 *
 *   M1 "remove the decision-domain serialization" (drop FOR UPDATE from
 *      lockDecisionDomain + a delay inside insertReservation that
 *      guarantees both transactions have finished their reads before
 *      either writes). Prediction: two competing reservations under a
 *      per-execution budget that admits only one BOTH commit — the budget
 *      aggregate is overspent. This is the red record proving the
 *      production concurrency test detects exactly this mutation
 *      (the aggregate has no physical CHECK; the pivot lock is the only
 *      serialization point, exactly the WORK-002 lesson).
 *
 *   M2 "strip every service-level money guard" (M1's lock removal PLUS an
 *      unguarded wallet debit `balance = balance - amount`). Prediction:
 *      the loser's write drives the balance below zero and PostgreSQL's
 *      PHYSICAL CHECK `balance_micro_usd >= 0` rejects the transaction —
 *      an overdraft stays unrepresentable even with both service-level
 *      protections removed (durable backstop).
 *
 * The production store passes the same scenarios (asserted here as the
 * contrast record): exactly one commits, the loser is denied
 * BUDGET_EXCEEDED, committed usage never exceeds the limit.
 */

import { expect, test } from "vitest";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../src/modules/budgets/adapters/sql-budget-store";
import { createBudgetService } from "../../src/modules/budgets/application/budget-service";
import type { BudgetStore } from "../../src/modules/budgets/ports/budget-store";
import type { DatabasePort } from "../../src/platform/db/port";
import { uuidv7 } from "../../src/shared/ids";
import {
  ACTOR_ID,
  type BudgetWorld,
  balanceOf,
  seedBudgetWorld,
  walletIdOf,
} from "../integration/postgres/budgets-world";
import { definePgSuite } from "../integration/postgres/harness";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** M1: the decision-domain lock is removed (no FOR UPDATE anywhere). */
class UnlockedBudgetStore extends SqlBudgetStore {
  override async lockDecisionDomain(applicationId: string) {
    // Identical reads, WITHOUT the serialization: settings row unlocked,
    // budgets unlocked, wallets unlocked.
    const settings = await this.findFundingSettings(applicationId);
    const budgets = await this.listBudgets(applicationId);
    const wallets = await this.listWallets(applicationId);
    return { settings, budgets, wallets };
  }

  override async insertReservation(...args: Parameters<BudgetStore["insertReservation"]>) {
    // Widen the race window deterministically: both transactions finish
    // their decision reads before either writes.
    await sleep(60);
    return super.insertReservation(...args);
  }
}

/** M2: M1 + the wallet debit guard removed (plain subtraction). */
class UnguardedDebitStore extends UnlockedBudgetStore {
  override async debitWallet(walletId: string, applicationId: string, amountMicroUsd: string) {
    // The service-level `balance >= amount` guard is GONE; only the
    // physical CHECK remains.
    const result = await (
      this as unknown as {
        exec: {
          execute<T>(q: {
            sql: string;
            parameters?: readonly unknown[];
          }): Promise<{ rows: readonly T[] }>;
        };
      }
    ).exec.execute<Record<string, unknown>>({
      sql: `UPDATE budgets.wallets
SET balance_micro_usd = balance_micro_usd - $3, updated_at = now()
WHERE id = $1 AND application_id = $2
RETURNING id, application_id, tenant_id, owner_kind, owner_id, currency, balance_micro_usd, created_at, updated_at`,
      parameters: [walletId, applicationId, amountMicroUsd],
    });
    const row = result.rows[0];
    return row === undefined ? null : (row as never);
  }
}

interface Seeded {
  readonly world: BudgetWorld;
  readonly scope: { actorId: string; applicationId: string; tenantId: string };
  readonly walletId: string;
}

async function seedBudgetContest(db: DatabasePort, round: string): Promise<Seeded> {
  const world = await seedBudgetWorld(db);
  const scope = { actorId: ACTOR_ID, applicationId: world.applicationId, tenantId: world.tenantId };
  await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, `dc-${round}`);
  await world.service.grantCredits(
    { ...scope, ownerKind: "developer", amountMicroUsd: "1000000" },
    `dg-${round}`,
  );
  await world.service.setBudget(
    { ...scope, scopeKind: "per-execution", limitMicroUsd: "1500" },
    `db-${round}`,
  );
  return { world, scope, walletId: await walletIdOf(db, world.applicationId, "developer") };
}

async function committedUsage(db: DatabasePort, applicationId: string, executionId: string) {
  const result = await db.execute<{ total: string }>({
    sql: `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
FROM budgets.reservations
WHERE application_id = $1 AND execution_id = $2 AND status IN ('active', 'settled')`,
    parameters: [applicationId, executionId],
  });
  return BigInt(result.rows[0]?.total ?? "0");
}

function mutantBudgetService(
  db: DatabasePort,
  mutant: new (exec: ConstructorParameters<typeof SqlBudgetStore>[0]) => SqlBudgetStore,
) {
  return createBudgetService({
    store: new mutant(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new mutant(tx), uuidv7),
    generateId: uuidv7,
    now: () => new Date(),
  });
}

async function firePair(
  service: ReturnType<typeof createBudgetService>,
  scope: Seeded["scope"],
  round: string,
) {
  const attempt = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: { code?: string; message?: string }) => `fail:${error.code ?? error.message}`,
    );
  return Promise.all([
    attempt(
      service.reserve(
        {
          ...scope,
          executionId: `de-${round}`,
          operationId: `do-${round}-a`,
          amountMicroUsd: "1000",
        },
        `dk-${round}-a`,
      ),
    ),
    attempt(
      service.reserve(
        {
          ...scope,
          executionId: `de-${round}`,
          operationId: `do-${round}-b`,
          amountMicroUsd: "1000",
        },
        `dk-${round}-b`,
      ),
    ),
  ]);
}

definePgSuite("discrimination: overspend mutations (real PG)", (ctx) => {
  test("M1 RED RECORD: removing the decision-domain lock lets BOTH competing reservations commit (budget overspent)", async () => {
    const seeded = await seedBudgetContest(ctx.port, "m1");
    const mutant = mutantBudgetService(ctx.port, UnlockedBudgetStore);

    const results = await firePair(mutant, seeded.scope, "m1");

    // The mutation IS the defect: both transactions committed, committed
    // usage (2000) exceeds the per-execution limit (1500). If this ever
    // stops reproducing, the mutation is no longer faithful.
    expect(results[0]).toBe("ok");
    expect(results[1]).toBe("ok");
    const usage = await committedUsage(ctx.port, seeded.scope.applicationId, "de-m1");
    expect(usage).toBe(2000n);
    expect(usage > 1500n).toBe(true); // overspend observed under the mutant

    // Contrast (green): the SAME contest through the production store.
    const seededGreen = await seedBudgetContest(ctx.port, "m1g");
    const resultsGreen = await firePair(seededGreen.world.service, seededGreen.scope, "m1g");
    expect(resultsGreen.filter((r) => r === "ok")).toHaveLength(1);
    expect(resultsGreen.filter((r) => r.startsWith("fail:BUDGET_EXCEEDED"))).toHaveLength(1);
    const usageGreen = await committedUsage(ctx.port, seededGreen.scope.applicationId, "de-m1g");
    expect(usageGreen <= 1500n).toBe(true); // invariant holds with the lock
  });

  test("M2 PHYSICAL BACKSTOP: with lock AND debit guard removed, PostgreSQL's CHECK still rejects the overdraft", async () => {
    // No budget limit this time: the contest is purely over the wallet's
    // exact remaining balance.
    const world = await seedBudgetWorld(ctx.port);
    const scope = {
      actorId: ACTOR_ID,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    };
    await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, "dc-m2");
    await world.service.grantCredits(
      { ...scope, ownerKind: "developer", amountMicroUsd: "1000" },
      "dg-m2",
    );
    const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");

    const mutant = mutantBudgetService(ctx.port, UnguardedDebitStore);

    const results = await firePair(mutant, scope, "m2");
    // Exactly one committed; the loser's unguarded write would have driven
    // the balance to -1000 and the PHYSICAL CHECK rejected the transaction
    // (PostgreSQL SQLSTATE 23514 = check_violation on
    // wallets_balance_never_negative).
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    const failures = results.filter((r) => r !== "ok");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/fail:23514|check constraint|wallets_balance_never_negative/);
    // No overdraft was committed; the balance never went negative.
    expect(await balanceOf(ctx.port, walletId)).toBe("0");
  });
});
