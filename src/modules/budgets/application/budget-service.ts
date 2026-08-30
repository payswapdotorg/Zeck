/**
 * Budget service (budgets module application; BUD-001..BUD-005).
 *
 * The durable economic authority consulted BEFORE dispatch
 * (`IMPLEMENTATION.md` §7 "budget reservation (when needed)" precedes the
 * adapter call). Executions (WORK-006) will consult the exported
 * `BudgetAuthority` surface — reserve before billable work, settle actual
 * usage once, release unused holds once — exactly how the connections and
 * models fabrics were built underneath Execution in WORK-003.
 *
 * Concurrency discipline (WORK-002 lesson, lock-the-full-decision-domain):
 * every reservation decision runs INSIDE the arbitration transaction and
 * starts with `lockDecisionDomain` — the application's funding-settings
 * row lock first (the pivot every reserve writer passes through), then
 * budget rows, then wallets, in deterministic order. All decision inputs
 * (funding mode, limits, balances, usage aggregates) are re-derived under
 * the lock; concurrent reservation writers totally order per application.
 * Settlement/release decisions lock the reservation row and re-derive its
 * status under the lock — never from a pre-lock read.
 *
 * Money: integer micro-USD decimal strings end to end; every amount parses
 * through `parseMicroUsd` (floats/negatives unrepresentable) and all
 * arithmetic is `bigint`.
 *
 * Authorization is NOT re-implemented here: callers are post-authorization
 * modules (executions, policy engine) and admin composition roots; the
 * budgets module owns economics, not identity (auth/policies own that —
 * recorded as a design decision in the WORK-004 evidence).
 */

import { PlatformError } from "../../../shared/errors";
import {
  BUDGET_CHECK_ORDER,
  type BudgetDenialReason,
  type BudgetRecord,
  type BudgetScopeKind,
  eligibleWalletSources,
  type FundingMode,
  type FundingSettings,
  type FundingSourceKind,
  greaterThan,
  isFundingMode,
  type LedgerEntryRecord,
  type MicroUsd,
  microUsdFromBigint,
  modeRequiresUser,
  monthKeyOf,
  parseMicroUsd,
  type ReservationRecord,
  type WalletOwnerKind,
  type WalletRecord,
} from "../domain";
import {
  type BudgetsIdempotencyPort,
  type BudgetTx,
  canonicalFingerprint,
} from "../ports/budget-idempotency";
import type { AppendLedgerEntryInput, BudgetStore } from "../ports/budget-store";

// ---------------------------------------------------------------------------
// Commands and outcomes
// ---------------------------------------------------------------------------

export interface BudgetCommandScope {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface ConfigureFundingModeCommand extends BudgetCommandScope {
  readonly fundingMode: FundingMode;
  readonly allowUserLimits?: boolean;
}

export interface GrantCreditsCommand extends BudgetCommandScope {
  readonly ownerKind: WalletOwnerKind;
  /** End-user identity for `user` wallets; ignored for developer/subsidy. */
  readonly ownerId?: string;
  readonly amountMicroUsd: string;
  readonly memo?: string | null;
}

export interface SetBudgetCommand extends BudgetCommandScope {
  readonly scopeKind: BudgetScopeKind;
  readonly limitMicroUsd: string;
  /** Required for `user-monthly`; must be absent for application scopes. */
  readonly userId?: string;
}

export interface ReserveCommand extends BudgetCommandScope {
  /** The logical execution the billable operation belongs to. */
  readonly executionId: string;
  /** The logical billable operation — unique per application. */
  readonly operationId: string;
  /** End user the spend is attributed to (required for user/hybrid modes). */
  readonly userId?: string;
  readonly amountMicroUsd: string;
}

export interface SettleCommand extends BudgetCommandScope {
  readonly operationId: string;
  /** Actual observed usage (integer micro-USD; 0 settles to a full refund). */
  readonly actualAmountMicroUsd: string;
}

export interface ReleaseCommand extends BudgetCommandScope {
  readonly operationId: string;
}

export interface MutationOutcome<T> {
  readonly outcome: T;
  /** True when a previous request's durable outcome was replayed. */
  readonly replayed: boolean;
}

export interface ReserveOutcome {
  readonly reservation: ReservationRecord;
  /** True when an existing reservation for the SAME logical operation was reused (no second hold). */
  readonly converged: boolean;
  readonly replayed: boolean;
}

export interface SettleOutcome {
  readonly reservation: ReservationRecord;
  /** True when the reservation was already settled with the SAME actual amount. */
  readonly converged: boolean;
  readonly replayed: boolean;
}

export interface ReleaseOutcome {
  readonly reservation: ReservationRecord;
  /** True when the reservation was already released. */
  readonly converged: boolean;
  readonly replayed: boolean;
}

export interface GrantCreditsOutcome {
  readonly wallet: WalletRecord;
  readonly replayed: boolean;
}

export interface ConfigureFundingOutcome {
  readonly settings: FundingSettings;
  readonly replayed: boolean;
}

export interface SetBudgetOutcome {
  readonly budget: BudgetRecord;
  readonly replayed: boolean;
}

export interface BudgetService {
  configureFundingMode(
    command: ConfigureFundingModeCommand,
    idempotencyKey: string,
  ): Promise<ConfigureFundingOutcome>;
  grantCredits(command: GrantCreditsCommand, idempotencyKey: string): Promise<GrantCreditsOutcome>;
  setBudget(command: SetBudgetCommand, idempotencyKey: string): Promise<SetBudgetOutcome>;
  reserve(command: ReserveCommand, idempotencyKey: string): Promise<ReserveOutcome>;
  settle(command: SettleCommand, idempotencyKey: string): Promise<SettleOutcome>;
  release(command: ReleaseCommand, idempotencyKey: string): Promise<ReleaseOutcome>;

  getFundingSettings(applicationId: string): Promise<FundingSettings | null>;
  getBudgets(applicationId: string): Promise<readonly BudgetRecord[]>;
  getWallets(applicationId: string): Promise<readonly WalletRecord[]>;
  getReservation(applicationId: string, operationId: string): Promise<ReservationRecord | null>;
  getWalletLedger(walletId: string): Promise<readonly LedgerEntryRecord[]>;
}

export interface BudgetServiceDeps {
  /** Root store for queries (mutations receive the transaction-bound store). */
  readonly store: BudgetStore;
  readonly idempotency: BudgetsIdempotencyPort;
  readonly generateId: () => string;
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createBudgetService(deps: BudgetServiceDeps): BudgetService {
  const { store, idempotency, generateId, now } = deps;

  const scopeOf = (command: BudgetCommandScope) => ({
    actorId: command.actorId,
    applicationId: command.applicationId,
  });

  const budgetDenied = (
    reason: BudgetDenialReason,
    details: Record<string, unknown>,
    retryable = false,
  ): PlatformError =>
    new PlatformError({
      code: "BUDGET_EXCEEDED",
      message: `reservation denied: ${reason}`,
      retryable,
      details: { reason, ...details },
    });

  const assertTenant = (command: BudgetCommandScope, rowTenantId: string): void => {
    if (rowTenantId !== command.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "budget authority row belongs to a different tenant",
        details: { applicationId: command.applicationId },
      });
    }
  };

  /** Budget admission in the frozen evaluation order — first failure is THE denial. */
  const evaluateBudgets = async (
    txStore: BudgetStore,
    command: ReserveCommand & { readonly userId: string; readonly amount: MicroUsd },
    settings: FundingSettings,
    budgets: readonly BudgetRecord[],
  ): Promise<void> => {
    const monthKey = monthKeyOf(now());
    const amount = command.amount;
    const userId = command.userId;

    for (const scope of BUDGET_CHECK_ORDER) {
      if (scope === "user-monthly" && (userId === "" || !settings.allowUserLimits)) {
        // BUD-002: user limits apply only where the application permits
        // them and only to attributed user spend.
        continue;
      }
      const limit = budgets.find(
        (row) =>
          row.scopeKind === scope && (scope === "user-monthly" ? row.userId === userId : true),
      );
      if (limit === undefined) {
        continue;
      }
      const committed =
        scope === "per-execution"
          ? await txStore.usageForExecution(command.applicationId, command.executionId)
          : scope === "monthly"
            ? await txStore.usageForMonth(command.applicationId, monthKey)
            : await txStore.usageForMonth(command.applicationId, monthKey, userId);
      const total = BigInt(committed) + BigInt(amount);
      if (total > BigInt(limit.limitMicroUsd)) {
        throw budgetDenied(
          scope === "per-execution"
            ? "execution-budget"
            : scope === "monthly"
              ? "monthly-budget"
              : "user-limit",
          {
            scope,
            limitMicroUsd: limit.limitMicroUsd,
            committedMicroUsd: committed,
            requestedMicroUsd: amount,
          },
        );
      }
    }
  };

  return {
    async configureFundingMode(command, idempotencyKey) {
      if (!isFundingMode(command.fundingMode)) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `unknown funding mode ${String(command.fundingMode)}`,
        });
      }
      const allowUserLimits = command.allowUserLimits ?? true;
      const { outcome, replayed } = await idempotency.arbitrate(
        scopeOf(command),
        "budgets.configure-funding",
        idempotencyKey,
        canonicalFingerprint([
          "budgets.configure-funding",
          command.applicationId,
          command.fundingMode,
          allowUserLimits,
        ]),
        async (tx: BudgetTx) => ({
          settings: await tx.store.upsertFundingSettings({
            applicationId: command.applicationId,
            tenantId: command.tenantId,
            fundingMode: command.fundingMode,
            allowUserLimits,
          }),
        }),
      );
      return { settings: outcome.settings, replayed };
    },

    async grantCredits(command, idempotencyKey) {
      const amount = parseMicroUsd(command.amountMicroUsd);
      const ownerId = command.ownerKind === "user" ? (command.ownerId ?? "") : "";
      if (command.ownerKind === "user" && ownerId === "") {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "user wallet grants require an ownerId",
        });
      }
      const { outcome, replayed } = await idempotency.arbitrate(
        scopeOf(command),
        "budgets.grant-credits",
        idempotencyKey,
        canonicalFingerprint([
          "budgets.grant-credits",
          command.applicationId,
          command.ownerKind,
          ownerId,
          amount,
        ]),
        async (tx: BudgetTx) => {
          const wallet =
            (await tx.store.findWallet(command.applicationId, command.ownerKind, ownerId)) ??
            (await tx.store.insertWallet({
              id: generateId(),
              applicationId: command.applicationId,
              tenantId: command.tenantId,
              ownerKind: command.ownerKind,
              ownerId,
            })) ??
            (await tx.store.findWallet(command.applicationId, command.ownerKind, ownerId));
          if (wallet === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "wallet vanished during grant arbitration",
            });
          }
          assertTenant(command, wallet.tenantId);
          const credited = await tx.store.creditWallet(wallet.id, command.applicationId, amount);
          if (credited === null) {
            throw new PlatformError({ code: "PROVIDER_ERROR", message: "wallet credit failed" });
          }
          await tx.store.appendLedgerEntry({
            id: generateId(),
            applicationId: command.applicationId,
            tenantId: command.tenantId,
            walletId: wallet.id,
            reservationId: null,
            entryClass: "credit-grant",
            direction: "credit",
            amountMicroUsd: amount,
            monthKey: monthKeyOf(now()),
            memo: command.memo ?? null,
          });
          return { wallet: credited };
        },
      );
      return { wallet: outcome.wallet, replayed };
    },

    async setBudget(command, idempotencyKey) {
      const limit = parseMicroUsd(command.limitMicroUsd);
      if (limit === "0") {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "budget limits must be positive",
        });
      }
      const userId = command.scopeKind === "user-monthly" ? (command.userId ?? "") : "";
      if (command.scopeKind === "user-monthly" && userId === "") {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "user-monthly budgets require a userId",
        });
      }
      const { outcome, replayed } = await idempotency.arbitrate(
        scopeOf(command),
        "budgets.set-budget",
        idempotencyKey,
        canonicalFingerprint([
          "budgets.set-budget",
          command.applicationId,
          command.scopeKind,
          userId,
          limit,
        ]),
        async (tx: BudgetTx) => ({
          budget: await tx.store.upsertBudget({
            id: generateId(),
            applicationId: command.applicationId,
            tenantId: command.tenantId,
            scopeKind: command.scopeKind,
            userId,
            limitMicroUsd: limit,
          }),
        }),
      );
      return { budget: outcome.budget, replayed };
    },

    async reserve(command, idempotencyKey) {
      const amount = parseMicroUsd(command.amountMicroUsd);
      if (amount === "0") {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "reservation amount must be a positive integer micro-USD amount",
        });
      }
      const userId = command.userId ?? "";

      const work = async (
        tx: BudgetTx,
      ): Promise<{ reservation: ReservationRecord; converged: boolean }> => {
        // 1. Lock the FULL decision domain (settings pivot first), then
        //    re-derive every input under the lock.
        const domain = await tx.store.lockDecisionDomain(command.applicationId);
        if (domain.settings === null) {
          // Fail closed: no funding policy -> no admission. This also
          // guarantees the serialization pivot row exists for every
          // decision ever made.
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "application funding policy is not configured",
            details: { applicationId: command.applicationId },
          });
        }
        assertTenant(command, domain.settings.tenantId);
        const mode = domain.settings.fundingMode;
        if (!isFundingMode(mode)) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "stored funding mode is outside the frozen vocabulary",
          });
        }
        if (modeRequiresUser(mode) && userId === "") {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: `funding mode ${mode} requires an end user`,
            details: { fundingMode: mode },
          });
        }

        // 2. Budget admission — deterministic precedence, first failure wins.
        await evaluateBudgets(
          tx.store,
          { ...command, userId, amount },
          domain.settings,
          domain.budgets,
        );

        // 3. Funding resolution — single-source draw in precedence order.
        let walletId: string | null = null;
        let sourceKind: FundingSourceKind = "byok";
        if (mode !== "byok") {
          const eligible = eligibleWalletSources(mode);
          const chosen = eligible
            .map((kind) => ({
              kind,
              wallet: domain.wallets.find(
                (row) => row.ownerKind === kind && row.ownerId === (kind === "user" ? userId : ""),
              ),
            }))
            .find(
              (candidate) =>
                candidate.wallet !== undefined &&
                !greaterThan(amount, candidate.wallet.balanceMicroUsd as MicroUsd),
            );
          if (chosen === undefined || chosen.wallet === undefined) {
            throw budgetDenied("insufficient-funds", {
              fundingMode: mode,
              eligibleSources: eligible,
              requestedMicroUsd: amount,
            });
          }
          walletId = chosen.wallet.id;
          sourceKind = chosen.kind;
        }

        // 4. Exactly one reservation per logical billable operation.
        const inserted = await tx.store.insertReservation({
          id: generateId(),
          applicationId: command.applicationId,
          tenantId: command.tenantId,
          executionId: command.executionId,
          operationId: command.operationId,
          userId,
          fundingMode: mode,
          sourceKind,
          walletId,
          amountMicroUsd: amount,
          monthKey: monthKeyOf(now()),
        });
        if (inserted === null) {
          const existing = await tx.store.findReservationByOperation(
            command.applicationId,
            command.operationId,
          );
          if (
            existing !== null &&
            existing.amountMicroUsd === amount &&
            existing.executionId === command.executionId &&
            existing.userId === userId &&
            existing.fundingMode === mode
          ) {
            // Converge: the SAME logical operation is already held — reuse
            // it, never place a second hold.
            return { reservation: existing, converged: true };
          }
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "operation already reserved with a different request",
            details: { operationId: command.operationId },
          });
        }

        // 5. Move the money (guarded debit; physical CHECK backstop).
        if (walletId !== null) {
          const debited = await tx.store.debitWallet(walletId, command.applicationId, amount);
          if (debited === null) {
            throw budgetDenied("insufficient-funds", {
              fundingMode: mode,
              requestedMicroUsd: amount,
            });
          }
          const entry: AppendLedgerEntryInput = {
            id: generateId(),
            applicationId: command.applicationId,
            tenantId: command.tenantId,
            walletId,
            reservationId: inserted.id,
            entryClass: "reservation-hold",
            direction: "debit",
            amountMicroUsd: amount,
            monthKey: inserted.monthKey,
            memo: null,
          };
          await tx.store.appendLedgerEntry(entry);
        }
        return { reservation: inserted, converged: false };
      };

      const { outcome, replayed } = await idempotency.arbitrate(
        scopeOf(command),
        "budgets.reserve",
        idempotencyKey,
        canonicalFingerprint([
          "budgets.reserve",
          command.applicationId,
          command.executionId,
          command.operationId,
          userId,
          amount,
        ]),
        work,
      );
      return { ...outcome, replayed };
    },

    async settle(command, idempotencyKey) {
      const actual = parseMicroUsd(command.actualAmountMicroUsd);

      const work = async (
        tx: BudgetTx,
      ): Promise<{ reservation: ReservationRecord; converged: boolean }> => {
        // Lock the reservation and re-derive its state under the lock.
        const reservation = await tx.store.lockReservation(
          command.applicationId,
          command.operationId,
        );
        if (reservation === null) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "no reservation exists for the operation",
            details: { operationId: command.operationId },
          });
        }
        assertTenant(command, reservation.tenantId);

        if (reservation.status === "settled") {
          if (reservation.settledAmountMicroUsd === actual) {
            return { reservation, converged: true };
          }
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "operation already settled with a different actual amount",
            details: {
              operationId: command.operationId,
              settledAmountMicroUsd: reservation.settledAmountMicroUsd,
            },
          });
        }
        if (reservation.status === "released") {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "cannot settle a released reservation",
            details: { operationId: command.operationId },
          });
        }

        const reserved = parseMicroUsd(reservation.amountMicroUsd);
        if (reservation.walletId !== null) {
          if (actual === reserved) {
            // Hold was exact — no money movement, settlement only.
          } else if (greaterThan(reserved, actual)) {
            const unused = microUsdFromBigint(BigInt(reserved) - BigInt(actual));
            const credited = await tx.store.creditWallet(
              reservation.walletId,
              command.applicationId,
              unused,
            );
            if (credited === null) {
              throw new PlatformError({ code: "PROVIDER_ERROR", message: "wallet credit failed" });
            }
            await tx.store.appendLedgerEntry({
              id: generateId(),
              applicationId: command.applicationId,
              tenantId: command.tenantId,
              walletId: reservation.walletId,
              reservationId: reservation.id,
              entryClass: "settle-release",
              direction: "credit",
              amountMicroUsd: unused,
              monthKey: reservation.monthKey,
              memo: null,
            });
          } else {
            const overage = microUsdFromBigint(BigInt(actual) - BigInt(reserved));
            const debited = await tx.store.debitWallet(
              reservation.walletId,
              command.applicationId,
              overage,
            );
            if (debited === null) {
              // Usage already happened; the operator grants credits and
              // retries the SAME settle (idempotency preserved).
              throw budgetDenied(
                "insufficient-funds-at-settlement",
                { operationId: command.operationId, overageMicroUsd: overage },
                true,
              );
            }
            await tx.store.appendLedgerEntry({
              id: generateId(),
              applicationId: command.applicationId,
              tenantId: command.tenantId,
              walletId: reservation.walletId,
              reservationId: reservation.id,
              entryClass: "settle-overage",
              direction: "debit",
              amountMicroUsd: overage,
              monthKey: reservation.monthKey,
              memo: null,
            });
          }
        }

        const finalized = await tx.store.finalizeReservationSettled(
          reservation.id,
          command.applicationId,
          actual,
        );
        if (finalized === null) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "reservation finalized concurrently",
            details: { operationId: command.operationId },
          });
        }
        return { reservation: finalized, converged: false };
      };

      const { outcome, replayed } = await idempotency.arbitrate(
        scopeOf(command),
        "budgets.settle",
        idempotencyKey,
        canonicalFingerprint([
          "budgets.settle",
          command.applicationId,
          command.operationId,
          actual,
        ]),
        work,
      );
      return { ...outcome, replayed };
    },

    async release(command, idempotencyKey) {
      const work = async (
        tx: BudgetTx,
      ): Promise<{ reservation: ReservationRecord; converged: boolean }> => {
        const reservation = await tx.store.lockReservation(
          command.applicationId,
          command.operationId,
        );
        if (reservation === null) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "no reservation exists for the operation",
            details: { operationId: command.operationId },
          });
        }
        assertTenant(command, reservation.tenantId);

        if (reservation.status === "released") {
          return { reservation, converged: true };
        }
        if (reservation.status === "settled") {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message:
              "cannot release a settled reservation (unused amount is returned at settlement)",
            details: { operationId: command.operationId },
          });
        }

        if (reservation.walletId !== null) {
          const reserved = parseMicroUsd(reservation.amountMicroUsd);
          const credited = await tx.store.creditWallet(
            reservation.walletId,
            command.applicationId,
            reserved,
          );
          if (credited === null) {
            throw new PlatformError({ code: "PROVIDER_ERROR", message: "wallet credit failed" });
          }
          await tx.store.appendLedgerEntry({
            id: generateId(),
            applicationId: command.applicationId,
            tenantId: command.tenantId,
            walletId: reservation.walletId,
            reservationId: reservation.id,
            entryClass: "reservation-release",
            direction: "credit",
            amountMicroUsd: reserved,
            monthKey: reservation.monthKey,
            memo: null,
          });
        }

        const finalized = await tx.store.finalizeReservationReleased(
          reservation.id,
          command.applicationId,
        );
        if (finalized === null) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "reservation finalized concurrently",
            details: { operationId: command.operationId },
          });
        }
        return { reservation: finalized, converged: false };
      };

      const { outcome, replayed } = await idempotency.arbitrate(
        scopeOf(command),
        "budgets.release",
        idempotencyKey,
        canonicalFingerprint(["budgets.release", command.applicationId, command.operationId]),
        work,
      );
      return { ...outcome, replayed };
    },

    getFundingSettings: (applicationId) => store.findFundingSettings(applicationId),
    getBudgets: (applicationId) => store.listBudgets(applicationId),
    getWallets: (applicationId) => store.listWallets(applicationId),
    getReservation: (applicationId, operationId) =>
      store.findReservationByOperation(applicationId, operationId),
    getWalletLedger: (walletId) => store.listLedgerEntriesByWallet(walletId),
  };
}
