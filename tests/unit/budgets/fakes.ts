/**
 * In-memory fakes of the budgets module ports (unit-test infrastructure).
 *
 * Faithful to the durable contract the SQL adapter implements:
 *  - unique keys (wallet per funding source; reservation per logical
 *    operation) surface as `null` returns, never as duplicate rows;
 *  - the guarded debit refuses insufficient balances;
 *  - idempotency arbitration replays same-fingerprint outcomes and rejects
 *    same-key/different-fingerprint with `IDEMPOTENCY_KEY_REUSED`.
 *
 * Concurrency/locking cannot be simulated here (no interleaving exists in
 * a single-threaded store) — the real-PostgreSQL suites own those proofs.
 */

import { createBudgetService } from "../../../src/modules/budgets/application/budget-service";
import type { BudgetRecord } from "../../../src/modules/budgets/domain/budget";
import type { FundingMode, WalletOwnerKind } from "../../../src/modules/budgets/domain/funding";
import type { MicroUsd } from "../../../src/modules/budgets/domain/money";
import type { ReservationRecord } from "../../../src/modules/budgets/domain/reservation";
import type {
  FundingSettings,
  LedgerEntryRecord,
  WalletRecord,
} from "../../../src/modules/budgets/domain/wallet";
import type {
  BudgetsIdempotencyPort,
  BudgetsIdempotencyScope,
  BudgetTx,
} from "../../../src/modules/budgets/ports/budget-idempotency";
import type {
  AppendLedgerEntryInput,
  BudgetStore,
  DecisionDomain,
  InsertReservationInput,
  InsertWalletInput,
  UpsertBudgetInput,
  UpsertFundingSettingsInput,
} from "../../../src/modules/budgets/ports/budget-store";
import { PlatformError } from "../../../src/shared/errors";

export class InMemoryBudgetStore implements BudgetStore {
  readonly wallets = new Map<string, WalletRecord>();
  readonly settings = new Map<string, FundingSettings>();
  readonly budgets = new Map<string, BudgetRecord>();
  readonly reservations = new Map<string, ReservationRecord>();
  readonly ledger: LedgerEntryRecord[] = [];

  async upsertFundingSettings(input: UpsertFundingSettingsInput): Promise<FundingSettings> {
    const existing = this.settings.get(input.applicationId);
    const row: FundingSettings = {
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      fundingMode: input.fundingMode,
      allowUserLimits: input.allowUserLimits,
      updatedAt: existing?.updatedAt ?? "2026-01-01T00:00:00.000Z",
    };
    this.settings.set(input.applicationId, row);
    return row;
  }

  async findFundingSettings(applicationId: string): Promise<FundingSettings | null> {
    return this.settings.get(applicationId) ?? null;
  }

  async lockDecisionDomain(applicationId: string): Promise<DecisionDomain> {
    return {
      settings: this.settings.get(applicationId) ?? null,
      budgets: [...this.budgets.values()].filter((row) => row.applicationId === applicationId),
      wallets: [...this.wallets.values()].filter((row) => row.applicationId === applicationId),
    };
  }

  async upsertBudget(input: UpsertBudgetInput): Promise<BudgetRecord> {
    const key = `${input.applicationId}:${input.scopeKind}:${input.userId}`;
    const existing = this.budgets.get(key);
    const row: BudgetRecord = {
      id: existing?.id ?? input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      scopeKind: input.scopeKind,
      userId: input.userId,
      limitMicroUsd: input.limitMicroUsd,
      createdAt: existing?.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.budgets.set(key, row);
    return row;
  }

  async listBudgets(applicationId: string): Promise<readonly BudgetRecord[]> {
    return [...this.budgets.values()].filter((row) => row.applicationId === applicationId);
  }

  async insertWallet(input: InsertWalletInput): Promise<WalletRecord | null> {
    for (const row of this.wallets.values()) {
      if (
        row.applicationId === input.applicationId &&
        row.ownerKind === input.ownerKind &&
        row.ownerId === input.ownerId
      ) {
        return null;
      }
    }
    const row: WalletRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      currency: "usd-micro",
      balanceMicroUsd: "0",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.wallets.set(row.id, row);
    return row;
  }

  async findWallet(
    applicationId: string,
    ownerKind: WalletOwnerKind,
    ownerId: string,
  ): Promise<WalletRecord | null> {
    for (const row of this.wallets.values()) {
      if (
        row.applicationId === applicationId &&
        row.ownerKind === ownerKind &&
        row.ownerId === ownerId
      ) {
        return row;
      }
    }
    return null;
  }

  async listWallets(applicationId: string): Promise<readonly WalletRecord[]> {
    return [...this.wallets.values()].filter((row) => row.applicationId === applicationId);
  }

  async creditWallet(
    walletId: string,
    applicationId: string,
    amountMicroUsd: MicroUsd,
  ): Promise<WalletRecord | null> {
    const row = this.wallets.get(walletId);
    if (row === undefined || row.applicationId !== applicationId) {
      return null;
    }
    const next = {
      ...row,
      balanceMicroUsd: (BigInt(row.balanceMicroUsd) + BigInt(amountMicroUsd)).toString(),
    };
    this.wallets.set(walletId, next);
    return next;
  }

  async debitWallet(
    walletId: string,
    applicationId: string,
    amountMicroUsd: MicroUsd,
  ): Promise<WalletRecord | null> {
    const row = this.wallets.get(walletId);
    if (row === undefined || row.applicationId !== applicationId) {
      return null;
    }
    if (BigInt(row.balanceMicroUsd) < BigInt(amountMicroUsd)) {
      return null;
    }
    const next = {
      ...row,
      balanceMicroUsd: (BigInt(row.balanceMicroUsd) - BigInt(amountMicroUsd)).toString(),
    };
    this.wallets.set(walletId, next);
    return next;
  }

  async insertReservation(input: InsertReservationInput): Promise<ReservationRecord | null> {
    for (const row of this.reservations.values()) {
      if (row.applicationId === input.applicationId && row.operationId === input.operationId) {
        return null;
      }
    }
    const row: ReservationRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      operationId: input.operationId,
      userId: input.userId,
      fundingMode: input.fundingMode,
      sourceKind: input.sourceKind,
      walletId: input.walletId,
      amountMicroUsd: input.amountMicroUsd,
      status: "active",
      settledAmountMicroUsd: null,
      monthKey: input.monthKey,
      createdAt: "2026-01-01T00:00:00.000Z",
      finalizedAt: null,
    };
    this.reservations.set(row.id, row);
    return row;
  }

  async findReservationByOperation(
    applicationId: string,
    operationId: string,
  ): Promise<ReservationRecord | null> {
    for (const row of this.reservations.values()) {
      if (row.applicationId === applicationId && row.operationId === operationId) {
        return row;
      }
    }
    return null;
  }

  async lockReservation(
    applicationId: string,
    operationId: string,
  ): Promise<ReservationRecord | null> {
    return this.findReservationByOperation(applicationId, operationId);
  }

  async finalizeReservationSettled(
    id: string,
    applicationId: string,
    settledAmountMicroUsd: MicroUsd,
  ): Promise<ReservationRecord | null> {
    const row = this.reservations.get(id);
    if (row === undefined || row.applicationId !== applicationId || row.status !== "active") {
      return null;
    }
    const next = {
      ...row,
      status: "settled" as const,
      settledAmountMicroUsd,
      finalizedAt: "2026-01-02T00:00:00.000Z",
    };
    this.reservations.set(id, next);
    return next;
  }

  async finalizeReservationReleased(
    id: string,
    applicationId: string,
  ): Promise<ReservationRecord | null> {
    const row = this.reservations.get(id);
    if (row === undefined || row.applicationId !== applicationId || row.status !== "active") {
      return null;
    }
    const next = { ...row, status: "released" as const, finalizedAt: "2026-01-02T00:00:00.000Z" };
    this.reservations.set(id, next);
    return next;
  }

  async appendLedgerEntry(input: AppendLedgerEntryInput): Promise<LedgerEntryRecord> {
    const row: LedgerEntryRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      walletId: input.walletId,
      reservationId: input.reservationId,
      entryClass: input.entryClass,
      direction: input.direction,
      amountMicroUsd: input.amountMicroUsd,
      monthKey: input.monthKey,
      memo: input.memo,
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    this.ledger.push(row);
    return row;
  }

  async listLedgerEntriesByWallet(walletId: string): Promise<readonly LedgerEntryRecord[]> {
    return this.ledger.filter((row) => row.walletId === walletId);
  }

  async usageForExecution(applicationId: string, executionId: string): Promise<MicroUsd> {
    let total = 0n;
    for (const row of this.reservations.values()) {
      if (
        row.applicationId === applicationId &&
        row.executionId === executionId &&
        row.status !== "released"
      ) {
        total += BigInt(
          row.status === "settled" ? (row.settledAmountMicroUsd ?? "0") : row.amountMicroUsd,
        );
      }
    }
    return total.toString() as MicroUsd;
  }

  async usageForMonth(applicationId: string, monthKey: string, userId?: string): Promise<MicroUsd> {
    let total = 0n;
    for (const row of this.reservations.values()) {
      if (
        row.applicationId === applicationId &&
        row.monthKey === monthKey &&
        row.status !== "released" &&
        (userId === undefined || row.userId === userId)
      ) {
        total += BigInt(
          row.status === "settled" ? (row.settledAmountMicroUsd ?? "0") : row.amountMicroUsd,
        );
      }
    }
    return total.toString() as MicroUsd;
  }
}

interface RecordedOutcome {
  readonly fingerprint: string;
  readonly outcome: unknown;
}

export class InMemoryBudgetsIdempotency implements BudgetsIdempotencyPort {
  private readonly records = new Map<string, RecordedOutcome>();

  constructor(private readonly store: BudgetStore) {}

  async arbitrate<T>(
    scope: BudgetsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: BudgetTx) => Promise<T>,
  ): Promise<{ outcome: T; replayed: boolean }> {
    const key = `${scope.applicationId}:${operationName}:${idempotencyKey}`;
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          details: { operationName },
        });
      }
      return { outcome: existing.outcome as T, replayed: true };
    }
    const outcome = await work({ store: this.store });
    this.records.set(key, { fingerprint: requestFingerprint, outcome });
    return { outcome, replayed: false };
  }
}

let counter = 0;

/** Deterministic ids for unit tests. */
export function sequenceId(prefix: string): () => string {
  return () => {
    counter += 1;
    return `${prefix}-${counter.toString().padStart(4, "0")}`;
  };
}

export function createInMemoryBudgets(now: () => Date = () => new Date("2026-03-15T12:00:00Z")) {
  const store = new InMemoryBudgetStore();
  const idempotency = new InMemoryBudgetsIdempotency(store);
  const generateId = sequenceId("id");
  const service = createBudgetService({ store, idempotency, generateId, now });
  return { store, idempotency, service, generateId };
}

export const TENANT = "tenant-1";
export const APP = "app-1";
export const ACTOR = "actor-1";

export function baseCommand(
  scope: { applicationId?: string; tenantId?: string; actorId?: string } = {},
) {
  return {
    actorId: scope.actorId ?? ACTOR,
    applicationId: scope.applicationId ?? APP,
    tenantId: scope.tenantId ?? TENANT,
  };
}

/** Configure funding + grant funds in one call (test convenience). */
export async function fundedApp(
  service: ReturnType<typeof createInMemoryBudgets>["service"],
  options: {
    mode: FundingMode;
    developer?: string;
    subsidy?: string;
    user?: string;
    userId?: string;
  },
): Promise<void> {
  const salt = Math.random().toString(36).slice(2, 8);
  await service.configureFundingMode(
    { ...baseCommand(), fundingMode: options.mode },
    `cfg-${options.mode}-${salt}`,
  );
  if (options.developer !== undefined) {
    await service.grantCredits(
      { ...baseCommand(), ownerKind: "developer", amountMicroUsd: options.developer },
      `grant-dev-${salt}`,
    );
  }
  if (options.subsidy !== undefined) {
    await service.grantCredits(
      { ...baseCommand(), ownerKind: "subsidy", amountMicroUsd: options.subsidy },
      `grant-sub-${salt}`,
    );
  }
  if (options.user !== undefined && options.userId !== undefined) {
    await service.grantCredits(
      {
        ...baseCommand(),
        ownerKind: "user",
        ownerId: options.userId,
        amountMicroUsd: options.user,
      },
      `grant-user-${salt}`,
    );
  }
}
