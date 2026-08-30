/**
 * Real-PostgreSQL: CONCURRENT reservation safety (WORK-004 acceptance
 * criterion 6; checkpoint CONCURRENCY-CRASH-SAFETY; BUD-004).
 *
 * Genuinely concurrent transactions (independent pool clients, the same
 * full SQL fabric) fire competing reservations against the exact remaining
 * balance / budget, multiple rounds for stability (the WORK-002
 * owner-retention suite style):
 *
 *   * exact-remaining-balance rounds (2-way and 3-way): N transactions
 *     each try to reserve the ENTIRE remaining balance -> exactly ONE
 *     commits; every loser is denied BUDGET_EXCEEDED/insufficient-funds;
 *     the committed end state has a non-negative balance, one hold and
 *     one debit ledger entry. The wallet's atomic guard plus the physical
 *     CHECK make an overdraft unrepresentable even under full overlap.
 *
 *   * budget-aggregate rounds: two competing reservations of different
 *     operations under one execution whose per-execution budget admits
 *     only ONE of them -> exactly one commits; committed usage never
 *     exceeds the limit. This is the race the decision-domain pivot lock
 *     exists for (aggregate CHECKs cannot exist; the lock is the only
 *     serialization point).
 *
 *   * same-logical-operation rounds: two concurrent reserves of the SAME
 *     operation with DIFFERENT keys converge to one hold, one debit.
 *
 *   * finalize race: concurrent settle vs release of one hold -> exactly
 *     one finalizes; the loser receives INVALID_STATE_TRANSITION; money is
 *     credited exactly once.
 */

import { expect, test } from "vitest";
import type { DatabasePort } from "../../../src/platform/db/port";
import { ACTOR_ID, balanceOf, seedBudgetWorld, walletIdOf } from "./budgets-world";
import { definePgSuite } from "./harness";

interface Attempt {
  readonly ok: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly converged?: boolean;
}

async function attempt(promise: Promise<unknown>): Promise<Attempt> {
  try {
    const result = (await promise) as { converged?: boolean };
    return { ok: true, converged: result.converged };
  } catch (error) {
    const err = error as { code?: string; details?: { reason?: string } };
    return { ok: false, code: err.code, reason: err.details?.reason };
  }
}

async function counts(db: DatabasePort, applicationId: string) {
  const result = await db.execute<{
    reservations: number;
    holds: number;
    settled: number;
    released: number;
  }>({
    sql: `SELECT
  (SELECT count(*)::int FROM budgets.reservations WHERE application_id = $1) AS reservations,
  (SELECT count(*)::int FROM budgets.ledger_entries WHERE application_id = $1 AND entry_class = 'reservation-hold') AS holds,
  (SELECT count(*)::int FROM budgets.reservations WHERE application_id = $1 AND status = 'settled') AS settled,
  (SELECT count(*)::int FROM budgets.reservations WHERE application_id = $1 AND status = 'released') AS released`,
    parameters: [applicationId],
  });
  return result.rows[0] as {
    reservations: number;
    holds: number;
    settled: number;
    released: number;
  };
}

definePgSuite("budgets concurrency: reservations cannot overspend (real PG)", (ctx) => {
  test("exact-remaining-balance rounds: two competing full-balance reservations — exactly one commits", async () => {
    const ROUNDS = 6;
    const committedRounds: number[] = [];
    for (let round = 1; round <= ROUNDS; round += 1) {
      const world = await seedBudgetWorld(ctx.port);
      const scope = {
        actorId: ACTOR_ID,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      await world.service.configureFundingMode(
        { ...scope, fundingMode: "developer" },
        `cfg-${round}`,
      );
      const BALANCE = "1000";
      await world.service.grantCredits(
        { ...scope, ownerKind: "developer", amountMicroUsd: BALANCE },
        `grant-${round}`,
      );
      const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");

      const results = await Promise.all([
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `exec-${round}`,
              operationId: `op-${round}-a`,
              amountMicroUsd: BALANCE,
            },
            `key-${round}-a`,
          ),
        ),
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `exec-${round}`,
              operationId: `op-${round}-b`,
              amountMicroUsd: BALANCE,
            },
            `key-${round}-b`,
          ),
        ),
      ]);

      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners, `round ${round}: exactly one reservation commits`).toHaveLength(1);
      expect(losers, `round ${round}: the loser is denied, not errored`).toHaveLength(1);
      expect(losers[0]?.code).toBe("BUDGET_EXCEEDED");
      expect(losers[0]?.reason).toBe("insufficient-funds");

      // Committed end state: whole balance held, nothing overdrawn.
      const balance = await balanceOf(ctx.port, walletId);
      expect(balance, `round ${round}`).toBe("0");
      const state = await counts(ctx.port, world.applicationId);
      expect(state.reservations).toBe(1);
      expect(state.holds).toBe(1);
      committedRounds.push(winners.length);
    }
    expect(committedRounds).toHaveLength(ROUNDS);
  });

  test("exact-remaining-balance rounds: THREE competing reservations — exactly one commits", async () => {
    const ROUNDS = 4;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const world = await seedBudgetWorld(ctx.port);
      const scope = {
        actorId: ACTOR_ID,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      await world.service.configureFundingMode(
        { ...scope, fundingMode: "subsidy" },
        `cfg3-${round}`,
      );
      await world.service.grantCredits(
        { ...scope, ownerKind: "subsidy", amountMicroUsd: "700" },
        `grant3-${round}`,
      );
      const walletId = await walletIdOf(ctx.port, world.applicationId, "subsidy");

      const results = await Promise.all(
        ["a", "b", "c"].map((suffix) =>
          attempt(
            world.service.reserve(
              {
                ...scope,
                executionId: `exec3-${round}`,
                operationId: `op3-${round}-${suffix}`,
                amountMicroUsd: "700",
              },
              `key3-${round}-${suffix}`,
            ),
          ),
        ),
      );

      expect(
        results.filter((r) => r.ok),
        `round ${round}: exactly one of three commits`,
      ).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(2);
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser.code).toBe("BUDGET_EXCEEDED");
        expect(loser.reason).toBe("insufficient-funds");
      }
      expect(await balanceOf(ctx.port, walletId)).toBe("0");
      const state = await counts(ctx.port, world.applicationId);
      expect(state.reservations).toBe(1);
      expect(state.holds).toBe(1);
    }
  });

  test("budget-aggregate rounds: competing operations under one execution budget — usage never exceeds the limit", async () => {
    const ROUNDS = 6;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const world = await seedBudgetWorld(ctx.port);
      const scope = {
        actorId: ACTOR_ID,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      await world.service.configureFundingMode(
        { ...scope, fundingMode: "developer" },
        `cfgb-${round}`,
      );
      // Wallet is deliberately AMBLE: the wallet guard cannot save the
      // budget here — only the decision-domain serialization can.
      await world.service.grantCredits(
        { ...scope, ownerKind: "developer", amountMicroUsd: "1000000" },
        `grantb-${round}`,
      );
      await world.service.setBudget(
        { ...scope, scopeKind: "per-execution", limitMicroUsd: "1500" },
        `budget-${round}`,
      );

      const results = await Promise.all([
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `execb-${round}`,
              operationId: `opb-${round}-a`,
              amountMicroUsd: "1000",
            },
            `keyb-${round}-a`,
          ),
        ),
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `execb-${round}`,
              operationId: `opb-${round}-b`,
              amountMicroUsd: "1000",
            },
            `keyb-${round}-b`,
          ),
        ),
      ]);

      const winners = results.filter((r) => r.ok);
      expect(winners, `round ${round}: the budget admits exactly one`).toHaveLength(1);
      const losers = results.filter((r) => !r.ok);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("BUDGET_EXCEEDED");
      expect(losers[0]?.reason).toBe("execution-budget");

      const usage = await ctx.port.execute<{ total: string }>({
        sql: `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
FROM budgets.reservations
WHERE application_id = $1 AND execution_id = $2 AND status IN ('active', 'settled')`,
        parameters: [world.applicationId, `execb-${round}`],
      });
      const committed = usage.rows[0]?.total ?? "0";
      expect(BigInt(committed) <= 1500n, `round ${round}: committed ${committed} <= limit`).toBe(
        true,
      );
      const state = await counts(ctx.port, world.applicationId);
      expect(state.reservations).toBe(1);
    }
  });

  test("same-logical-operation rounds: concurrent reserves with different keys converge to ONE hold", async () => {
    const ROUNDS = 4;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const world = await seedBudgetWorld(ctx.port);
      const scope = {
        actorId: ACTOR_ID,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      await world.service.configureFundingMode(
        { ...scope, fundingMode: "developer" },
        `cfgc-${round}`,
      );
      await world.service.grantCredits(
        { ...scope, ownerKind: "developer", amountMicroUsd: "10000" },
        `grantc-${round}`,
      );
      const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");

      const results = await Promise.all([
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `execc-${round}`,
              operationId: `opc-${round}`,
              amountMicroUsd: "3000",
            },
            `keyc-${round}-1`,
          ),
        ),
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `execc-${round}`,
              operationId: `opc-${round}`,
              amountMicroUsd: "3000",
            },
            `keyc-${round}-2`,
          ),
        ),
      ]);

      // Both callers succeed (the logical operation is held), but exactly
      // one placed the hold; the other converged onto it.
      expect(
        results.every((r) => r.ok),
        `round ${round}`,
      ).toBe(true);
      expect(
        results.filter((r) => r.converged === false),
        `round ${round}: one first writer`,
      ).toHaveLength(1);
      expect(
        results.filter((r) => r.converged === true),
        `round ${round}: one converger`,
      ).toHaveLength(1);
      // The balance was debited EXACTLY ONCE — no double hold.
      expect(await balanceOf(ctx.port, walletId)).toBe("7000");
      const state = await counts(ctx.port, world.applicationId);
      expect(state.reservations).toBe(1);
      expect(state.holds).toBe(1);
    }
  });

  test("finalize race: concurrent settle vs release of one hold — exactly one finalizes, money credited once", async () => {
    const ROUNDS = 4;
    for (let round = 1; round <= ROUNDS; round += 1) {
      const world = await seedBudgetWorld(ctx.port);
      const scope = {
        actorId: ACTOR_ID,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      await world.service.configureFundingMode(
        { ...scope, fundingMode: "developer" },
        `cfgf-${round}`,
      );
      await world.service.grantCredits(
        { ...scope, ownerKind: "developer", amountMicroUsd: "5000" },
        `grantf-${round}`,
      );
      await world.service.reserve(
        {
          ...scope,
          executionId: `execf-${round}`,
          operationId: `opf-${round}`,
          amountMicroUsd: "2000",
        },
        `resf-${round}`,
      );
      const walletId = await walletIdOf(ctx.port, world.applicationId, "developer");
      expect(await balanceOf(ctx.port, walletId)).toBe("3000");

      const [settleResult, releaseResult] = await Promise.all([
        attempt(
          world.service.settle(
            { ...scope, operationId: `opf-${round}`, actualAmountMicroUsd: "500" },
            `setf-${round}`,
          ),
        ),
        attempt(world.service.release({ ...scope, operationId: `opf-${round}` }, `relf-${round}`)),
      ]);

      const winners = [settleResult, releaseResult].filter((r) => r.ok);
      expect(winners, `round ${round}: exactly one finalizer wins the row lock`).toHaveLength(1);
      const loser = settleResult.ok ? releaseResult : settleResult;
      expect(loser.code).toBe("INVALID_STATE_TRANSITION");

      const state = await counts(ctx.port, world.applicationId);
      expect(state.reservations).toBe(1);
      expect(state.settled + state.released).toBe(1);
      // Money credited exactly once: either settle (refund 1500 -> 4500)
      // or release (refund 2000 -> 5000) — never both.
      const balance = await balanceOf(ctx.port, walletId);
      expect(balance === "4500" || balance === "5000", `round ${round}: balance ${balance}`).toBe(
        true,
      );
      const credits = await ctx.port.execute<{ total: string }>({
        sql: `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
FROM budgets.ledger_entries
WHERE application_id = $1 AND direction = 'credit' AND entry_class IN ('settle-release', 'reservation-release')`,
        parameters: [world.applicationId],
      });
      expect(credits.rows[0]?.total).toBe(balance === "4500" ? "1500" : "2000");
    }
  });

  test("parallel applications do not interfere: concurrent reserves across different applications all commit", async () => {
    const worlds = [];
    for (let i = 0; i < 3; i += 1) {
      const world = await seedBudgetWorld(ctx.port);
      const scope = {
        actorId: ACTOR_ID,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      await world.service.configureFundingMode({ ...scope, fundingMode: "developer" }, `cfgp-${i}`);
      await world.service.grantCredits(
        { ...scope, ownerKind: "developer", amountMicroUsd: "1000" },
        `grantp-${i}`,
      );
      worlds.push({ world, scope });
    }
    const results = await Promise.all(
      worlds.map(({ world, scope }, i) =>
        attempt(
          world.service.reserve(
            {
              ...scope,
              executionId: `execp-${i}`,
              operationId: `opp-${i}`,
              amountMicroUsd: "1000",
            },
            `keyp-${i}`,
          ),
        ),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true); // per-application pivots are independent
    for (const { world } of worlds) {
      expect(
        await balanceOf(ctx.port, await walletIdOf(ctx.port, world.applicationId, "developer")),
      ).toBe("0");
    }
  });
});
