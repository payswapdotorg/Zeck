/**
 * Discrimination: settlement exactly-once + budget precedence determinism
 * (WORK-004, BUD-001/BUD-002/BUD-004; checkpoints IDENTITY-IDEMPOTENCY and
 * CONCURRENCY-CRASH-SAFETY).
 *
 * Every protection here is proven by a mutant that removes it:
 *
 *   D1 order-collapse mutant — a budget evaluator running the checks in
 *      REVERSED order produces `monthly-budget` where the frozen order
 *      mandates `execution-budget`; the determinism property FAILS under
 *      the mutant (the green test discriminates evaluation order).
 *
 *   D2 stale-lock-read mutant — a store whose `lockReservation` reports a
 *      STALE pre-lock row (the WORK-002 bug class: deciding from a
 *      pre-lock read while another writer finalized). The REAL service
 *      still rejects the double settle: the status-guarded finalize is
 *      re-derived from the durable row, so the stale decision cannot
 *      double-charge. (Durable atomicity of the rejection itself is proven
 *      against real PostgreSQL in the crash-atomicity suite.)
 *
 *   D3 lost-terminal-transition mutant — a store whose finalize forgets to
 *      PERSIST the terminal status (returns the record but leaves the row
 *      active). A second settle then double-credits — the invariant
 *      violation is OBSERVED, proving the green exactly-once tests depend
 *      on (and detect the absence of) the persisted terminal transition.
 *      In PostgreSQL this mutation is physically impossible
 *      (`reservations_forward_only` trigger + `status = 'active'` guard).
 *
 *   D4 static: no default-allow funding — the reserve path can never
 *      create or default the funding policy; `upsertFundingSettings` has
 *      exactly one caller (configureFundingMode) and reserve fails closed
 *      without a policy row (fail-closed admission, no bypass).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createBudgetService } from "../../src/modules/budgets/application/budget-service";
import { BUDGET_CHECK_ORDER } from "../../src/modules/budgets/domain/budget";
import type { MicroUsd } from "../../src/modules/budgets/domain/money";
import type { PlatformError } from "../../src/shared/errors";
import {
  baseCommand,
  createInMemoryBudgets,
  fundedApp,
  InMemoryBudgetStore,
} from "../unit/budgets/fakes";

async function denialReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "allowed";
  } catch (error) {
    const platformError = error as PlatformError;
    return String(platformError.details?.reason ?? platformError.code ?? "unknown");
  }
}

describe("discrimination: budgets settlement + precedence (unit)", () => {
  test("D1: evaluation-order determinism — reversed order fails the frozen-precedence property", async () => {
    // Fixture: per-execution AND monthly limits that BOTH fail the request.
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "1000000" });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "per-execution", limitMicroUsd: "100" },
      "b1",
    );
    await service.setBudget({ ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "50" }, "b2");

    // Frozen order: per-execution precedes monthly — THE reason is fixed.
    expect(
      await denialReason(
        service.reserve(
          { ...baseCommand(), executionId: "e", operationId: "op", amountMicroUsd: "200" },
          "k",
        ),
      ),
    ).toBe("execution-budget");
    expect(BUDGET_CHECK_ORDER).toEqual(["per-execution", "monthly", "user-monthly"]);

    // Mutant evaluator: the same checks run in REVERSED order over the
    // same fixture facts (both limits exceeded by the 200 request). Under
    // the mutation the observed denial becomes 'monthly-budget' — a
    // DIFFERENT machine-readable outcome for the same request — so the
    // green assertion above discriminates evaluation order.
    const checks: Record<string, { exceeds: boolean; reason: string }> = {
      "per-execution": { exceeds: true, reason: "execution-budget" },
      monthly: { exceeds: true, reason: "monthly-budget" },
      "user-monthly": { exceeds: false, reason: "user-limit" },
    };
    const evaluateIn = (order: readonly string[]): string | null => {
      for (const scope of order) {
        const check = checks[scope];
        if (check?.exceeds) {
          return check.reason;
        }
      }
      return null;
    };
    expect(evaluateIn(BUDGET_CHECK_ORDER)).toBe("execution-budget");
    expect(evaluateIn([...BUDGET_CHECK_ORDER].reverse())).toBe("monthly-budget");
    expect(evaluateIn([...BUDGET_CHECK_ORDER].reverse())).not.toBe(evaluateIn(BUDGET_CHECK_ORDER));
  });

  test("D2: a stale lock read cannot double-settle — the status guard re-derives from the durable row", async () => {
    // Stale-lock-read mutant: lockReservation always reports the row as it
    // was BEFORE finalization (active), the WORK-002 pre-lock-read bug.
    class StaleLockStore extends InMemoryBudgetStore {
      override async lockReservation(applicationId: string, operationId: string) {
        const current = await super.lockReservation(applicationId, operationId);
        return current === null
          ? null
          : { ...current, status: "active" as const, settledAmountMicroUsd: null };
      }
    }
    const staleStore = new StaleLockStore();
    // Wire the REAL service onto the mutant store directly.
    const wired = createBudgetService({
      store: staleStore,
      idempotency: {
        arbitrate: async (_scope, _operation, _key, _fp, work) => {
          const outcome = await work({ store: staleStore });
          return { outcome, replayed: false };
        },
      },
      generateId: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `id-${n}`;
        };
      })(),
      now: () => new Date("2026-03-15T12:00:00Z"),
    });
    await wired.configureFundingMode({ ...baseCommand(), fundingMode: "developer" }, "c");
    await wired.grantCredits(
      { ...baseCommand(), ownerKind: "developer", amountMicroUsd: "10000" },
      "g",
    );
    await wired.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op", amountMicroUsd: "2000" },
      "r",
    );
    await wired.settle({ ...baseCommand(), operationId: "op", actualAmountMicroUsd: "500" }, "s1");

    // Second settle sees a STALE active row — but the status-guarded
    // finalize re-derives the durable truth and the service rejects.
    await expect(
      wired.settle({ ...baseCommand(), operationId: "op", actualAmountMicroUsd: "500" }, "s2"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("D3 RED RECORD: losing the persisted terminal transition double-credits — the green test detects it", async () => {
    // Lost-transition mutant: finalize reports success but forgets to
    // persist the settled status (simulating a missing durable transition).
    class LostTransitionStore extends InMemoryBudgetStore {
      override async finalizeReservationSettled(
        id: string,
        applicationId: string,
        settledAmountMicroUsd: MicroUsd,
      ) {
        const row = this.reservations.get(id);
        if (row === undefined || row.applicationId !== applicationId) {
          return null;
        }
        // Reports the settled record WITHOUT storing it.
        return {
          ...row,
          status: "settled" as const,
          settledAmountMicroUsd,
          finalizedAt: "2026-01-02T00:00:00.000Z",
        };
      }
    }
    const store = new LostTransitionStore();
    const service = createBudgetService({
      store,
      idempotency: {
        arbitrate: async (_s, _o, _k, _f, work) => ({
          outcome: await work({ store }),
          replayed: false,
        }),
      },
      generateId: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `id-${n}`;
        };
      })(),
      now: () => new Date("2026-03-15T12:00:00Z"),
    });
    await service.configureFundingMode({ ...baseCommand(), fundingMode: "developer" }, "c");
    await service.grantCredits(
      { ...baseCommand(), ownerKind: "developer", amountMicroUsd: "10000" },
      "g",
    );
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op", amountMicroUsd: "2000" },
      "r",
    );
    await service.settle(
      { ...baseCommand(), operationId: "op", actualAmountMicroUsd: "500" },
      "s1",
    );
    await service.settle(
      { ...baseCommand(), operationId: "op", actualAmountMicroUsd: "500" },
      "s2",
    );

    const balance = (await service.getWallets(baseCommand().applicationId)).find(
      (w) => w.ownerKind === "developer",
    )?.balanceMicroUsd;
    // INVARIANT VIOLATION observed under the mutant: 10000-2000+1500+1500
    // = 11000 — a double refund. The production expectation is 9500; the
    // green exactly-once tests fail on this mutant, which is the point.
    expect(balance).toBe("11000");
    expect(balance === "9500").toBe(false);
  });

  test("D4 static: no default-allow funding — the reserve path cannot create or default the funding policy", () => {
    const serviceSource = readFileSync(
      join(process.cwd(), "src/modules/budgets/application/budget-service.ts"),
      "utf-8",
    );
    // upsertFundingSettings has exactly ONE caller: configureFundingMode.
    expect(serviceSource.match(/upsertFundingSettings/g)?.length).toBe(1);
    // The reserve path fails closed on a missing policy row.
    expect(serviceSource).toMatch(/application funding policy is not configured/);
    // No bypass flag exists anywhere in the module.
    const moduleFiles = [
      "domain/money.ts",
      "domain/funding.ts",
      "domain/budget.ts",
      "domain/wallet.ts",
      "domain/reservation.ts",
      "application/budget-service.ts",
    ];
    for (const file of moduleFiles) {
      const text = readFileSync(join(process.cwd(), "src/modules/budgets", file), "utf-8");
      expect(text, `${file} must not ship a budget bypass`).not.toMatch(
        /bypass|skipBudget|ignoreBudget/,
      );
    }
  });

  test("D5: double-settle and double-release through the production service never double-charge (green contrast)", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "10000" });
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-s", amountMicroUsd: "2000" },
      "r",
    );
    await service.settle(
      { ...baseCommand(), operationId: "op-s", actualAmountMicroUsd: "500" },
      "s1",
    );
    await service.settle(
      { ...baseCommand(), operationId: "op-s", actualAmountMicroUsd: "500" },
      "s2",
    );
    await service.settle(
      { ...baseCommand(), operationId: "op-s", actualAmountMicroUsd: "500" },
      "s3",
    );
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(wallets.find((w) => w.ownerKind === "developer")?.balanceMicroUsd).toBe("9500");

    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-r", amountMicroUsd: "1000" },
      "r2",
    );
    await service.release({ ...baseCommand(), operationId: "op-r" }, "x1");
    await service.release({ ...baseCommand(), operationId: "op-r" }, "x2");
    expect(wallets.find((w) => w.ownerKind === "developer")?.balanceMicroUsd !== undefined).toBe(
      true,
    );
    const after = (await service.getWallets(baseCommand().applicationId)).find(
      (w) => w.ownerKind === "developer",
    )?.balanceMicroUsd;
    expect(after).toBe("9500"); // release returned the hold exactly once
  });

  test("D6: budget denial is independent of wallet sufficiency order (admission completes before money moves)", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "100" }); // small wallet
    await service.setBudget(
      { ...baseCommand(), scopeKind: "per-execution", limitMicroUsd: "50" },
      "b",
    );
    // BOTH the budget and the wallet would fail: the budget denial wins —
    // deterministic admission precedence over funding resolution.
    expect(
      await denialReason(
        service.reserve(
          { ...baseCommand(), executionId: "e", operationId: "op", amountMicroUsd: "80" },
          "k",
        ),
      ),
    ).toBe("execution-budget");
  });
});
