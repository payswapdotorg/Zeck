/**
 * Budget store port (budgets module outbound).
 *
 * Implemented by adapters (SQL over the platform `DatabasePort`; in-memory
 * fakes in tests). Inner layers depend on this interface only — never on
 * platform types (`IMPLEMENTATION.md` §3).
 *
 * Concurrency contract (WORK-002 lock-before-decide discipline): every
 * reservation/wallet decision runs inside the arbitration transaction and
 * MUST begin with `lockDecisionDomain`, which takes the application's
 * funding-settings row lock FIRST (the serialization pivot every reserve
 * writer passes through), then the budget rows and the application's
 * wallets (deterministic id order — deadlock free). All decision inputs
 * (funding mode, budget limits, wallet balances, usage aggregates) are
 * read AFTER the pivot lock, so concurrent reservation writers of one
 * application totally order and each decision re-derives state as
 * committed by the winner — a narrow lock that missed a competing row is
 * exactly the bug class WORK-002 remediated.
 */

import type { BudgetRecord, BudgetScopeKind } from "../domain/budget";
import type { FundingMode, WalletOwnerKind } from "../domain/funding";
import type { MicroUsd } from "../domain/money";
import type { ReservationRecord, ReservationStatus } from "../domain/reservation";
import type {
  FundingSettings,
  LedgerDirection,
  LedgerEntryClass,
  LedgerEntryRecord,
  WalletRecord,
} from "../domain/wallet";

export interface UpsertFundingSettingsInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly fundingMode: FundingMode;
  readonly allowUserLimits: boolean;
}

export interface UpsertBudgetInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly scopeKind: BudgetScopeKind;
  readonly userId: string;
  readonly limitMicroUsd: MicroUsd;
}

export interface InsertWalletInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly ownerKind: WalletOwnerKind;
  readonly ownerId: string;
}

/** Everything a reservation decision reads, locked in deterministic order. */
export interface DecisionDomain {
  readonly settings: FundingSettings | null;
  readonly budgets: readonly BudgetRecord[];
  readonly wallets: readonly WalletRecord[];
}

export interface InsertReservationInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly fundingMode: FundingMode;
  readonly sourceKind: ReservationRecord["sourceKind"];
  readonly walletId: string | null;
  readonly amountMicroUsd: MicroUsd;
  readonly monthKey: string;
}

export interface AppendLedgerEntryInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly walletId: string;
  readonly reservationId: string | null;
  readonly entryClass: LedgerEntryClass;
  readonly direction: LedgerDirection;
  readonly amountMicroUsd: MicroUsd;
  readonly monthKey: string;
  readonly memo: string | null;
}

export interface BudgetStore {
  // --- funding policy -----------------------------------------------------
  upsertFundingSettings(input: UpsertFundingSettingsInput): Promise<FundingSettings>;
  findFundingSettings(applicationId: string): Promise<FundingSettings | null>;
  /**
   * Lock the FULL reservation decision domain of one application:
   * funding settings row FIRST (pivot), then budget rows, then wallets —
   * each `FOR UPDATE` in deterministic id order. MUST be called inside the
   * arbitration transaction before any decision read.
   */
  lockDecisionDomain(applicationId: string): Promise<DecisionDomain>;

  // --- budgets ------------------------------------------------------------
  upsertBudget(input: UpsertBudgetInput): Promise<BudgetRecord>;
  listBudgets(applicationId: string): Promise<readonly BudgetRecord[]>;

  // --- wallets ------------------------------------------------------------
  /** Insert; null when the (application, ownerKind, ownerId) wallet exists. */
  insertWallet(input: InsertWalletInput): Promise<WalletRecord | null>;
  findWallet(
    applicationId: string,
    ownerKind: WalletOwnerKind,
    ownerId: string,
  ): Promise<WalletRecord | null>;
  listWallets(applicationId: string): Promise<readonly WalletRecord[]>;
  /** Credit a wallet (grants, hold returns). Fails closed on unknown wallet. */
  creditWallet(
    walletId: string,
    applicationId: string,
    amountMicroUsd: MicroUsd,
  ): Promise<WalletRecord | null>;
  /**
   * Guarded debit: `balance >= amount` is re-checked atomically inside the
   * UPDATE (and the physical CHECK rejects negative balances even if this
   * guard were removed). Returns null when the wallet is unknown or
   * insufficient — never a negative balance.
   */
  debitWallet(
    walletId: string,
    applicationId: string,
    amountMicroUsd: MicroUsd,
  ): Promise<WalletRecord | null>;

  // --- reservations -------------------------------------------------------
  /** Insert; null when (applicationId, operationId) already holds a reservation. */
  insertReservation(input: InsertReservationInput): Promise<ReservationRecord | null>;
  findReservationByOperation(
    applicationId: string,
    operationId: string,
  ): Promise<ReservationRecord | null>;
  /** Lock the reservation row (`FOR UPDATE`) and return it as committed at lock acquisition. */
  lockReservation(applicationId: string, operationId: string): Promise<ReservationRecord | null>;
  /** active -> settled with the actual usage amount. Null when not active (raced/already final). */
  finalizeReservationSettled(
    id: string,
    applicationId: string,
    settledAmountMicroUsd: MicroUsd,
  ): Promise<ReservationRecord | null>;
  /** active -> released. Null when not active (raced/already final). */
  finalizeReservationReleased(id: string, applicationId: string): Promise<ReservationRecord | null>;

  // --- ledger -------------------------------------------------------------
  /** Append one entry. Append-only is PHYSICALLY enforced in PostgreSQL. */
  appendLedgerEntry(input: AppendLedgerEntryInput): Promise<LedgerEntryRecord>;
  listLedgerEntriesByWallet(walletId: string): Promise<readonly LedgerEntryRecord[]>;

  // --- usage aggregates (committed spend the budget checks consume) -------
  /**
   * Committed spend under one logical execution: holds at their reserved
   * amount + settled rows at their ACTUAL amount (released rows never
   * count).
   */
  usageForExecution(applicationId: string, executionId: string): Promise<MicroUsd>;
  /** Committed spend of an application (optionally one user) in a month window. */
  usageForMonth(applicationId: string, monthKey: string, userId?: string): Promise<MicroUsd>;
}

export type { BudgetRecord, BudgetScopeKind, ReservationStatus };
