/**
 * Unit: budget service over in-memory fakes (budgets module, WORK-004).
 *
 * Covers funding-mode resolution and draw order, budget evaluation
 * determinism, idempotent reservation replay/convergence, exactly-once
 * settle/release semantics and their negative cases. Concurrency and
 * physical-schema proofs live in the real-PostgreSQL and discrimination
 * suites; crash-atomicity is proven there too (a fake cannot roll back).
 */

import { describe, expect, test } from "vitest";
import type { ReservationRecord } from "../../../src/modules/budgets/public";
import { PlatformError } from "../../../src/shared/errors";
import { baseCommand, createInMemoryBudgets, fundedApp } from "./fakes";

const USER = "user-1";

async function expectPlatformError(
  promise: Promise<unknown>,
  code: string,
  details?: Record<string, unknown>,
): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    const platformError = error as PlatformError;
    expect(platformError.code).toBe(code);
    if (details !== undefined) {
      expect(platformError.details).toMatchObject(details);
    }
    return platformError;
  }
  throw new Error(`expected PlatformError ${code}, request succeeded`);
}

function walletBalanceOf(
  wallets: readonly { ownerKind: string; ownerId: string; balanceMicroUsd: string }[],
  ownerKind: string,
  ownerId = "",
): string {
  const wallet = wallets.find((row) => row.ownerKind === ownerKind && row.ownerId === ownerId);
  return wallet?.balanceMicroUsd ?? "0";
}

describe("budget service: admission", () => {
  test("reservation fails closed when no funding policy is configured", async () => {
    const { service } = createInMemoryBudgets();
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "exec-1", operationId: "op-1", amountMicroUsd: "10" },
        "key-1",
      ),
      "POLICY_DENIED",
    );
  });

  test("rejects zero, negative and float reservation amounts", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "1000" });
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e", operationId: "o0", amountMicroUsd: "0" },
        "k0",
      ),
      "POLICY_DENIED",
    );
    for (const bad of ["-5", "1.5", "abc"]) {
      await expect(
        service.reserve(
          { ...baseCommand(), executionId: "e", operationId: `o-${bad}`, amountMicroUsd: bad },
          `k-${bad}`,
        ),
      ).rejects.toThrow();
    }
  });

  test("commands with the wrong tenant are rejected as tenant-scope violations", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "1000" });
    await expectPlatformError(
      service.reserve(
        {
          ...baseCommand({ tenantId: "tenant-OTHER" }),
          executionId: "e",
          operationId: "op-x",
          amountMicroUsd: "10",
        },
        "key-x",
      ),
      "TENANT_SCOPE_VIOLATION",
    );
    const reservation = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-y", amountMicroUsd: "10" },
      "key-y",
    );
    expect(reservation.reservation.status).toBe("active");
    await expectPlatformError(
      service.settle(
        {
          ...baseCommand({ tenantId: "tenant-OTHER" }),
          operationId: "op-y",
          actualAmountMicroUsd: "5",
        },
        "key-y2",
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });
});

describe("budget service: funding modes and draw order", () => {
  test("developer mode draws the developer wallet and journals the hold", async () => {
    const { service, store } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "1000" });
    const result = await service.reserve(
      { ...baseCommand(), executionId: "e1", operationId: "op-1", amountMicroUsd: "300" },
      "key-1",
    );
    expect(result.reservation.sourceKind).toBe("developer");
    expect(result.reservation.status).toBe("active");
    expect(result.replayed).toBe(false);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("700");
    const walletId = result.reservation.walletId;
    expect(walletId).not.toBeNull();
    const entries = (await service.getWalletLedger(walletId as string)).filter(
      (e) => e.entryClass !== "credit-grant",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryClass: "reservation-hold",
      direction: "debit",
      amountMicroUsd: "300",
      reservationId: result.reservation.id,
    });
    expect(store.ledger).toHaveLength(2); // credit-grant + reservation-hold
  });

  test("user mode requires an end user and draws that user's wallet", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "user", user: "500", userId: USER });
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e", operationId: "op-nouser", amountMicroUsd: "10" },
        "k-nouser",
      ),
      "POLICY_DENIED",
    );
    const result = await service.reserve(
      {
        ...baseCommand(),
        executionId: "e",
        operationId: "op-user",
        userId: USER,
        amountMicroUsd: "200",
      },
      "key-user",
    );
    expect(result.reservation.sourceKind).toBe("user");
    expect(result.reservation.userId).toBe(USER);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "user", USER)).toBe("300");
  });

  test("hybrid mode draws user funds FIRST and the developer wallet as backstop", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "hybrid", user: "100", developer: "1000", userId: USER });

    const first = await service.reserve(
      {
        ...baseCommand(),
        executionId: "e",
        operationId: "op-h1",
        userId: USER,
        amountMicroUsd: "80",
      },
      "key-h1",
    );
    expect(first.reservation.sourceKind).toBe("user");

    // Only 20 user funds remain: a 100 draw skips the user wallet and
    // falls through to the developer backstop (single-source draw).
    const second = await service.reserve(
      {
        ...baseCommand(),
        executionId: "e",
        operationId: "op-h2",
        userId: USER,
        amountMicroUsd: "100",
      },
      "key-h2",
    );
    expect(second.reservation.sourceKind).toBe("developer");

    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "user", USER)).toBe("20");
    expect(walletBalanceOf(wallets, "developer")).toBe("900");
  });

  test("subsidy mode draws subsidy credits", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "subsidy", subsidy: "400" });
    const result = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-s", amountMicroUsd: "150" },
      "key-s",
    );
    expect(result.reservation.sourceKind).toBe("subsidy");
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "subsidy")).toBe("250");
  });

  test("byok mode holds no wallet and writes no ledger movement", async () => {
    const { service, store } = createInMemoryBudgets();
    await fundedApp(service, { mode: "byok" });
    const result = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-b", amountMicroUsd: "123" },
      "key-b",
    );
    expect(result.reservation.sourceKind).toBe("byok");
    expect(result.reservation.walletId).toBeNull();
    expect(store.ledger).toHaveLength(0);
    expect(await service.getWallets(baseCommand().applicationId)).toHaveLength(0);
  });

  test("insufficient funds across all eligible sources denies with a deterministic reason", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "hybrid", user: "10", developer: "50", userId: USER });
    await expectPlatformError(
      service.reserve(
        {
          ...baseCommand(),
          executionId: "e",
          operationId: "op-i",
          userId: USER,
          amountMicroUsd: "500",
        },
        "key-i",
      ),
      "BUDGET_EXCEEDED",
      { reason: "insufficient-funds" },
    );
  });

  test("a denied reservation moves no money at all", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "100" });
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e", operationId: "op-d", amountMicroUsd: "500" },
        "key-d",
      ),
      "BUDGET_EXCEEDED",
    );
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("100");
    expect(await service.getReservation(baseCommand().applicationId, "op-d")).toBeNull();
  });
});

describe("budget service: budgets and deterministic precedence (BUD-001/BUD-002)", () => {
  test("per-execution budget denies the over-limit reservation", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "100000" });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "per-execution", limitMicroUsd: "1000" },
      "budget-key-1",
    );
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e1", operationId: "op-1", amountMicroUsd: "1500" },
        "key-1",
      ),
      "BUDGET_EXCEEDED",
      { reason: "execution-budget", scope: "per-execution" },
    );
    // A different execution under the same limit is unaffected.
    const ok = await service.reserve(
      { ...baseCommand(), executionId: "e2", operationId: "op-2", amountMicroUsd: "1000" },
      "key-2",
    );
    expect(ok.reservation.status).toBe("active");
  });

  test("per-execution budget accumulates across operations of one execution", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "100000" });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "per-execution", limitMicroUsd: "1000" },
      "budget-key-a",
    );
    await service.reserve(
      { ...baseCommand(), executionId: "e1", operationId: "op-1", amountMicroUsd: "600" },
      "k1",
    );
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e1", operationId: "op-2", amountMicroUsd: "600" },
        "k2",
      ),
      "BUDGET_EXCEEDED",
      { reason: "execution-budget", committedMicroUsd: "600" },
    );
  });

  test("monthly budget denies spend beyond the UTC calendar-month window", async () => {
    let clock = new Date("2026-03-10T00:00:00Z");
    const { service } = createInMemoryBudgets(() => clock);
    await fundedApp(service, { mode: "developer", developer: "100000" });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "1000" },
      "budget-key-m",
    );
    await service.reserve(
      { ...baseCommand(), executionId: "e1", operationId: "op-1", amountMicroUsd: "700" },
      "k1",
    );
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e2", operationId: "op-2", amountMicroUsd: "400" },
        "k2",
      ),
      "BUDGET_EXCEEDED",
      { reason: "monthly-budget", scope: "monthly" },
    );
    // Next UTC month: the window resets deterministically.
    clock = new Date("2026-04-02T00:00:00Z");
    const april = await service.reserve(
      { ...baseCommand(), executionId: "e3", operationId: "op-3", amountMicroUsd: "400" },
      "k3",
    );
    expect(april.reservation.monthKey).toBe("2026-04");
  });

  test("deterministic precedence: when per-execution AND monthly both fail, execution-budget wins", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "100000" });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "per-execution", limitMicroUsd: "100" },
      "bk-exec",
    );
    await service.setBudget(
      { ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "50" },
      "bk-month",
    );
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e", operationId: "op-both", amountMicroUsd: "200" },
        "key-both",
      ),
      "BUDGET_EXCEEDED",
      { reason: "execution-budget" },
    );
  });

  test("deterministic precedence: monthly precedes user-monthly", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "user", user: "100000", userId: USER });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "50" },
      "bk-month2",
    );
    await service.setBudget(
      { ...baseCommand(), scopeKind: "user-monthly", limitMicroUsd: "100", userId: USER },
      "bk-user",
    );
    await expectPlatformError(
      service.reserve(
        {
          ...baseCommand(),
          executionId: "e",
          operationId: "op-mu",
          userId: USER,
          amountMicroUsd: "200",
        },
        "key-mu",
      ),
      "BUDGET_EXCEEDED",
      { reason: "monthly-budget" },
    );
  });

  test("user-monthly limits apply only where the application permits them (BUD-002)", async () => {
    const { service } = createInMemoryBudgets();
    await service.configureFundingMode(
      { ...baseCommand(), fundingMode: "user", allowUserLimits: false },
      "cfg-noperm",
    );
    await service.grantCredits(
      {
        ...baseCommand(),
        ownerKind: "user",
        ownerId: USER,
        amountMicroUsd: "100000",
      },
      "grant-noperm",
    );
    await service.setBudget(
      { ...baseCommand(), scopeKind: "user-monthly", limitMicroUsd: "100", userId: USER },
      "bk-user2",
    );
    // The user limit exists but is NOT enforced: the application does not
    // permit user-imposed limits.
    const ok = await service.reserve(
      {
        ...baseCommand(),
        executionId: "e",
        operationId: "op-u",
        userId: USER,
        amountMicroUsd: "5000",
      },
      "key-u",
    );
    expect(ok.reservation.status).toBe("active");
  });

  test("user-monthly limit denies the attributed user only", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "user", user: "100000", userId: USER });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "user-monthly", limitMicroUsd: "100", userId: USER },
      "bk-user3",
    );
    await service.reserve(
      {
        ...baseCommand(),
        executionId: "e",
        operationId: "op-u1",
        userId: USER,
        amountMicroUsd: "80",
      },
      "k-u1",
    );
    await expectPlatformError(
      service.reserve(
        {
          ...baseCommand(),
          executionId: "e",
          operationId: "op-u2",
          userId: USER,
          amountMicroUsd: "80",
        },
        "k-u2",
      ),
      "BUDGET_EXCEEDED",
      { reason: "user-limit", scope: "user-monthly" },
    );
  });

  test("budget usage counts settled actuals, not stale holds, and ignores released rows", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "100000" });
    await service.setBudget(
      { ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "1000" },
      "bk-month3",
    );
    // Hold 600, settle at 100: committed monthly usage is 100 now (the
    // stale 600 hold no longer counts).
    await service.reserve(
      { ...baseCommand(), executionId: "e1", operationId: "op-1", amountMicroUsd: "600" },
      "k1",
    );
    await service.settle(
      { ...baseCommand(), operationId: "op-1", actualAmountMicroUsd: "100" },
      "ks1",
    );
    // Hold 700, release: released rows never count.
    await service.reserve(
      { ...baseCommand(), executionId: "e2", operationId: "op-2", amountMicroUsd: "700" },
      "k2",
    );
    await service.release({ ...baseCommand(), operationId: "op-2" }, "kr2");
    // 100 committed + 900 hold = 1000: passes ONLY because the released
    // 700 is ignored (and the settled row counts at its actual 100).
    const ok = await service.reserve(
      { ...baseCommand(), executionId: "e3", operationId: "op-3", amountMicroUsd: "900" },
      "k3",
    );
    expect(ok.reservation.status).toBe("active");
    // One more micro-unit exceeds the window: the limit still binds.
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e4", operationId: "op-4", amountMicroUsd: "1" },
        "k4",
      ),
      "BUDGET_EXCEEDED",
      { reason: "monthly-budget", committedMicroUsd: "1000" },
    );
  });
});

describe("budget service: reservation idempotency (BUD-004)", () => {
  async function reservedFixture() {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "1000" });
    return service;
  }

  test("same key + same request replays the durable outcome with no second hold", async () => {
    const service = await reservedFixture();
    const first = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "300" },
      "key-replay",
    );
    expect(first.replayed).toBe(false);
    const replay = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "300" },
      "key-replay",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.converged).toBe(false);
    expect(replay.reservation.id).toBe(first.reservation.id);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("700");
  });

  test("same key + different request is idempotency key reuse", async () => {
    const service = await reservedFixture();
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "300" },
      "key-reuse",
    );
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "301" },
        "key-reuse",
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  test("different key + same logical operation CONVERGES on the existing hold", async () => {
    const service = await reservedFixture();
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "300" },
      "key-a",
    );
    const converged = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "300" },
      "key-b",
    );
    expect(converged.converged).toBe(true);
    expect(converged.replayed).toBe(false);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("700"); // one hold only
  });

  test("different key + different amount for the same operation is rejected", async () => {
    const service = await reservedFixture();
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "300" },
      "key-a2",
    );
    await expectPlatformError(
      service.reserve(
        { ...baseCommand(), executionId: "e", operationId: "op-1", amountMicroUsd: "500" },
        "key-b2",
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("budget service: settle and release exactly-once (BUD-004/BUD-005)", () => {
  async function activeHold(
    amount: string,
    op = "op-1",
  ): Promise<{
    service: ReturnType<typeof createInMemoryBudgets>["service"];
    reservation: ReservationRecord;
  }> {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "10000" });
    const result = await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: op, amountMicroUsd: amount },
      `key-${op}`,
    );
    return { service, reservation: result.reservation };
  }

  test("settle at exactly the hold moves no money, records the actual once", async () => {
    const { service, reservation } = await activeHold("300");
    const settled = await service.settle(
      { ...baseCommand(), operationId: reservation.operationId, actualAmountMicroUsd: "300" },
      "settle-key",
    );
    expect(settled.reservation.status).toBe("settled");
    expect(settled.reservation.settledAmountMicroUsd).toBe("300");
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("9700");
  });

  test("settle below the hold credits the unused amount and appends a settle-release entry", async () => {
    const { service, reservation } = await activeHold("300");
    await service.settle(
      { ...baseCommand(), operationId: reservation.operationId, actualAmountMicroUsd: "120" },
      "settle-key",
    );
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("9880");
    const entries = await service.getWalletLedger(reservation.walletId as string);
    expect(entries.map((e) => `${e.entryClass}:${e.direction}:${e.amountMicroUsd}`)).toEqual([
      "credit-grant:credit:10000",
      "reservation-hold:debit:300",
      "settle-release:credit:180",
    ]);
  });

  test("settle above the hold debits the overage and appends a settle-overage entry", async () => {
    const { service, reservation } = await activeHold("300");
    await service.settle(
      { ...baseCommand(), operationId: reservation.operationId, actualAmountMicroUsd: "450" },
      "settle-key",
    );
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("9550");
    const entries = await service.getWalletLedger(reservation.walletId as string);
    expect(entries.map((e) => `${e.entryClass}:${e.direction}:${e.amountMicroUsd}`)).toEqual([
      "credit-grant:credit:10000",
      "reservation-hold:debit:300",
      "settle-overage:debit:150",
    ]);
  });

  test("settle with zero actual usage refunds the whole hold", async () => {
    const { service, reservation } = await activeHold("300");
    await service.settle(
      { ...baseCommand(), operationId: reservation.operationId, actualAmountMicroUsd: "0" },
      "settle-key",
    );
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("10000");
  });

  test("double settle with the same key replays; with another key converges — never double-charges", async () => {
    const { service, reservation } = await activeHold("300", "op-ds");
    const first = await service.settle(
      { ...baseCommand(), operationId: "op-ds", actualAmountMicroUsd: "100" },
      "settle-1",
    );
    expect(first.replayed).toBe(false);
    const replay = await service.settle(
      { ...baseCommand(), operationId: "op-ds", actualAmountMicroUsd: "100" },
      "settle-1",
    );
    expect(replay.replayed).toBe(true);
    const converged = await service.settle(
      { ...baseCommand(), operationId: "op-ds", actualAmountMicroUsd: "100" },
      "settle-2",
    );
    expect(converged.converged).toBe(true);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("9900"); // refunded 200 exactly once
    const entries = await service.getWalletLedger(reservation.walletId as string);
    expect(entries.filter((e) => e.entryClass === "settle-release")).toHaveLength(1);
  });

  test("settle with a different actual amount after settlement is key reuse", async () => {
    const { service } = await activeHold("300", "op-diff");
    await service.settle(
      { ...baseCommand(), operationId: "op-diff", actualAmountMicroUsd: "100" },
      "settle-a",
    );
    await expectPlatformError(
      service.settle(
        { ...baseCommand(), operationId: "op-diff", actualAmountMicroUsd: "150" },
        "settle-b",
      ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  test("overage settlement with an empty wallet fails closed and leaves the hold active", async () => {
    const { service } = createInMemoryBudgets();
    await fundedApp(service, { mode: "developer", developer: "300" });
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-over", amountMicroUsd: "300" },
      "key-over",
    );
    const error = await expectPlatformError(
      service.settle(
        { ...baseCommand(), operationId: "op-over", actualAmountMicroUsd: "500" },
        "settle-over",
      ),
      "BUDGET_EXCEEDED",
      { reason: "insufficient-funds-at-settlement" },
    );
    expect(error.retryable).toBe(true);
    // The reservation stays honestly active — nothing partial committed.
    const reservation = await service.getReservation(baseCommand().applicationId, "op-over");
    expect(reservation?.status).toBe("active");
    // Granting credits and retrying the SAME settle succeeds (idempotent retry).
    await service.grantCredits(
      { ...baseCommand(), ownerKind: "developer", amountMicroUsd: "1000" },
      "grant-topup",
    );
    const settled = await service.settle(
      { ...baseCommand(), operationId: "op-over", actualAmountMicroUsd: "500" },
      "settle-over",
    );
    expect(settled.reservation.status).toBe("settled");
  });

  test("release returns the full hold exactly once", async () => {
    const { service, reservation } = await activeHold("300", "op-rel");
    const released = await service.release({ ...baseCommand(), operationId: "op-rel" }, "rel-1");
    expect(released.reservation.status).toBe("released");
    const replay = await service.release({ ...baseCommand(), operationId: "op-rel" }, "rel-1");
    expect(replay.replayed).toBe(true);
    const converged = await service.release({ ...baseCommand(), operationId: "op-rel" }, "rel-2");
    expect(converged.converged).toBe(true);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "developer")).toBe("10000");
    const entries = await service.getWalletLedger(reservation.walletId as string);
    expect(entries.filter((e) => e.entryClass === "reservation-release")).toHaveLength(1);
  });

  test("release after settle and settle after release are invalid state transitions", async () => {
    const settledService = await activeHold("300", "op-rs");
    await settledService.service.settle(
      { ...baseCommand(), operationId: "op-rs", actualAmountMicroUsd: "100" },
      "s-key",
    );
    await expectPlatformError(
      settledService.service.release({ ...baseCommand(), operationId: "op-rs" }, "r-key"),
      "INVALID_STATE_TRANSITION",
    );

    const releasedService = await activeHold("300", "op-sr");
    await releasedService.service.release({ ...baseCommand(), operationId: "op-sr" }, "r-key2");
    await expectPlatformError(
      releasedService.service.settle(
        { ...baseCommand(), operationId: "op-sr", actualAmountMicroUsd: "100" },
        "s-key2",
      ),
      "INVALID_STATE_TRANSITION",
    );
  });

  test("settle/release of an unknown operation is an invalid state transition", async () => {
    const { service } = await activeHold("300");
    await expectPlatformError(
      service.settle(
        { ...baseCommand(), operationId: "op-missing", actualAmountMicroUsd: "1" },
        "k",
      ),
      "INVALID_STATE_TRANSITION",
    );
    await expectPlatformError(
      service.release({ ...baseCommand(), operationId: "op-missing" }, "k2"),
      "INVALID_STATE_TRANSITION",
    );
  });

  test("byok settlement records actual usage without wallet movement", async () => {
    const { service, store } = createInMemoryBudgets();
    await fundedApp(service, { mode: "byok" });
    await service.reserve(
      { ...baseCommand(), executionId: "e", operationId: "op-byok", amountMicroUsd: "500" },
      "key-byok",
    );
    const settled = await service.settle(
      { ...baseCommand(), operationId: "op-byok", actualAmountMicroUsd: "420" },
      "settle-byok",
    );
    expect(settled.reservation.settledAmountMicroUsd).toBe("420");
    expect(store.ledger).toHaveLength(0);
  });
});

describe("budget service: grants and configuration idempotency", () => {
  test("credit grants replay idempotently (one credit, one ledger entry)", async () => {
    const { service, store } = createInMemoryBudgets();
    const first = await service.grantCredits(
      { ...baseCommand(), ownerKind: "subsidy", amountMicroUsd: "500", memo: "launch credits" },
      "grant-key",
    );
    expect(first.replayed).toBe(false);
    const replay = await service.grantCredits(
      { ...baseCommand(), ownerKind: "subsidy", amountMicroUsd: "500", memo: "launch credits" },
      "grant-key",
    );
    expect(replay.replayed).toBe(true);
    const wallets = await service.getWallets(baseCommand().applicationId);
    expect(walletBalanceOf(wallets, "subsidy")).toBe("500");
    expect(store.ledger.filter((e) => e.entryClass === "credit-grant")).toHaveLength(1);
  });

  test("funding-mode configuration replays and rejects unknown modes", async () => {
    const { service } = createInMemoryBudgets();
    const first = await service.configureFundingMode(
      { ...baseCommand(), fundingMode: "hybrid", allowUserLimits: false },
      "cfg-key",
    );
    const replay = await service.configureFundingMode(
      { ...baseCommand(), fundingMode: "hybrid", allowUserLimits: false },
      "cfg-key",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.settings).toEqual(first.settings);
    await expectPlatformError(
      service.configureFundingMode(
        { ...baseCommand(), fundingMode: "slush-fund" as never },
        "cfg-bad",
      ),
      "POLICY_DENIED",
    );
  });

  test("budget limits upsert per scope and reject zero limits / missing user", async () => {
    const { service } = createInMemoryBudgets();
    await service.setBudget(
      { ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "1000" },
      "b-1",
    );
    const updated = await service.setBudget(
      { ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "2000" },
      "b-2",
    );
    expect(updated.budget.limitMicroUsd).toBe("2000");
    const budgets = await service.getBudgets(baseCommand().applicationId);
    expect(budgets.filter((b) => b.scopeKind === "monthly")).toHaveLength(1);
    await expectPlatformError(
      service.setBudget({ ...baseCommand(), scopeKind: "monthly", limitMicroUsd: "0" }, "b-3"),
      "POLICY_DENIED",
    );
    await expectPlatformError(
      service.setBudget(
        { ...baseCommand(), scopeKind: "user-monthly", limitMicroUsd: "10" },
        "b-4",
      ),
      "POLICY_DENIED",
    );
  });
});
