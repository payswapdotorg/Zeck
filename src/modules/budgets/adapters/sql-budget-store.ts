/**
 * SQL adapter for the budgets module (WORK-004).
 *
 * Bridges `BudgetStore` and the module `BudgetsIdempotencyPort` to the
 * provider-neutral platform `DatabasePort`. No driver/SDK import happens
 * here — `pg` is owned by the platform DB layer per the SDK boundary table.
 *
 * The idempotency ledger reuses `platform.idempotency_records` (migration
 * 0001) with application-scoped arbitration keys — the same durable
 * arbitration contract as auth/applications/connections
 * (`spec/contracts.md` "Idempotency response rule").
 *
 * Concurrency: `lockDecisionDomain` acquires the funding-settings row lock
 * FIRST (the serialization pivot), then budget rows, then wallets — all
 * `FOR UPDATE` in deterministic id order. Wallet debits additionally carry
 * the atomic `balance >= amount` guard, and the physical CHECK
 * (`balance_micro_usd >= 0`) is the final backstop: an overspend is not
 * committable even with every service-level guard removed.
 *
 * Money crosses the wire as strings; PostgreSQL columns are `bigint`
 * (integer micro-USD only — floats unrepresentable).
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { BudgetRecord, BudgetScopeKind } from "../domain/budget";
import type { FundingMode, FundingSourceKind, WalletOwnerKind } from "../domain/funding";
import type { MicroUsd } from "../domain/money";
import type { ReservationRecord, ReservationStatus } from "../domain/reservation";
import type {
  FundingSettings,
  LedgerDirection,
  LedgerEntryClass,
  LedgerEntryRecord,
  WalletRecord,
} from "../domain/wallet";
import type {
  BudgetsIdempotencyArbitration,
  BudgetsIdempotencyPort,
  BudgetsIdempotencyScope,
  BudgetTx,
} from "../ports/budget-idempotency";
import type {
  AppendLedgerEntryInput,
  BudgetStore,
  DecisionDomain,
  InsertReservationInput,
  InsertWalletInput,
  UpsertBudgetInput,
  UpsertFundingSettingsInput,
} from "../ports/budget-store";

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

interface WalletRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly owner_kind: WalletOwnerKind;
  readonly owner_id: string;
  readonly currency: string;
  readonly balance_micro_usd: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const WALLET_COLUMNS =
  "id, application_id, tenant_id, owner_kind, owner_id, currency, balance_micro_usd, created_at, updated_at";

function toWallet(row: WalletRow): WalletRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    currency: "usd-micro",
    balanceMicroUsd: row.balance_micro_usd,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface SettingsRow {
  readonly application_id: string;
  readonly tenant_id: string;
  readonly funding_mode: FundingMode;
  readonly allow_user_limits: boolean;
  readonly updated_at: Date | string;
}

const SETTINGS_COLUMNS = "application_id, tenant_id, funding_mode, allow_user_limits, updated_at";

function toSettings(row: SettingsRow): FundingSettings {
  return {
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    fundingMode: row.funding_mode,
    allowUserLimits: row.allow_user_limits,
    updatedAt: iso(row.updated_at),
  };
}

interface BudgetRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly scope_kind: BudgetScopeKind;
  readonly user_id: string;
  readonly limit_micro_usd: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const BUDGET_COLUMNS =
  "id, application_id, tenant_id, scope_kind, user_id, limit_micro_usd, created_at, updated_at";

function toBudget(row: BudgetRow): BudgetRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    scopeKind: row.scope_kind,
    userId: row.user_id,
    limitMicroUsd: row.limit_micro_usd,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface ReservationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly operation_id: string;
  readonly user_id: string;
  readonly funding_mode: FundingMode;
  readonly source_kind: FundingSourceKind;
  readonly wallet_id: string | null;
  readonly amount_micro_usd: string;
  readonly status: ReservationStatus;
  readonly settled_amount_micro_usd: string | null;
  readonly month_key: string;
  readonly created_at: Date | string;
  readonly finalized_at: Date | string | null;
}

const RESERVATION_COLUMNS =
  "id, application_id, tenant_id, execution_id, operation_id, user_id, funding_mode, source_kind, wallet_id, amount_micro_usd, status, settled_amount_micro_usd, month_key, created_at, finalized_at";

function toReservation(row: ReservationRow): ReservationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    operationId: row.operation_id,
    userId: row.user_id,
    fundingMode: row.funding_mode,
    sourceKind: row.source_kind,
    walletId: row.wallet_id,
    amountMicroUsd: row.amount_micro_usd,
    status: row.status,
    settledAmountMicroUsd: row.settled_amount_micro_usd,
    monthKey: row.month_key,
    createdAt: iso(row.created_at),
    finalizedAt: row.finalized_at === null ? null : iso(row.finalized_at),
  };
}

interface LedgerRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly wallet_id: string;
  readonly reservation_id: string | null;
  readonly entry_class: LedgerEntryClass;
  readonly direction: LedgerDirection;
  readonly amount_micro_usd: string;
  readonly month_key: string;
  readonly memo: string | null;
  readonly occurred_at: Date | string;
}

const LEDGER_COLUMNS =
  "id, application_id, tenant_id, wallet_id, reservation_id, entry_class, direction, amount_micro_usd, month_key, memo, occurred_at";

function toLedgerEntry(row: LedgerRow): LedgerEntryRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    walletId: row.wallet_id,
    reservationId: row.reservation_id,
    entryClass: row.entry_class,
    direction: row.direction,
    amountMicroUsd: row.amount_micro_usd,
    monthKey: row.month_key,
    memo: row.memo,
    occurredAt: iso(row.occurred_at),
  };
}

export class SqlBudgetStore implements BudgetStore {
  constructor(private readonly exec: Executor) {}

  async upsertFundingSettings(input: UpsertFundingSettingsInput): Promise<FundingSettings> {
    const result = await this.exec.execute<SettingsRow>({
      sql: `INSERT INTO budgets.application_funding_settings
  (application_id, tenant_id, funding_mode, allow_user_limits)
VALUES ($1, $2, $3, $4)
ON CONFLICT (application_id) DO UPDATE SET
  funding_mode = EXCLUDED.funding_mode,
  allow_user_limits = EXCLUDED.allow_user_limits,
  updated_at = now()
RETURNING ${SETTINGS_COLUMNS}`,
      parameters: [input.applicationId, input.tenantId, input.fundingMode, input.allowUserLimits],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "funding settings upsert returned no row",
      });
    }
    return toSettings(row);
  }

  async findFundingSettings(applicationId: string): Promise<FundingSettings | null> {
    const result = await this.exec.execute<SettingsRow>({
      sql: `SELECT ${SETTINGS_COLUMNS} FROM budgets.application_funding_settings WHERE application_id = $1`,
      parameters: [applicationId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSettings(row);
  }

  async lockDecisionDomain(applicationId: string): Promise<DecisionDomain> {
    // Pivot FIRST: every reservation writer of this application queues on
    // this row lock, so the reads below re-derive the winner's committed
    // state (READ COMMITTED evaluates each statement against the latest
    // committed version after the lock is granted).
    const settings = await this.exec.execute<SettingsRow>({
      sql: `SELECT ${SETTINGS_COLUMNS} FROM budgets.application_funding_settings
WHERE application_id = $1 FOR UPDATE`,
      parameters: [applicationId],
    });
    const budgets = await this.exec.execute<BudgetRow>({
      sql: `SELECT ${BUDGET_COLUMNS} FROM budgets.budgets
WHERE application_id = $1 ORDER BY id FOR UPDATE`,
      parameters: [applicationId],
    });
    const wallets = await this.exec.execute<WalletRow>({
      sql: `SELECT ${WALLET_COLUMNS} FROM budgets.wallets
WHERE application_id = $1 ORDER BY id FOR UPDATE`,
      parameters: [applicationId],
    });
    return {
      settings: settings.rows.length === 0 ? null : toSettings(settings.rows[0] as SettingsRow),
      budgets: budgets.rows.map(toBudget),
      wallets: wallets.rows.map(toWallet),
    };
  }

  async upsertBudget(input: UpsertBudgetInput): Promise<BudgetRecord> {
    const result = await this.exec.execute<BudgetRow>({
      sql: `INSERT INTO budgets.budgets
  (id, application_id, tenant_id, scope_kind, user_id, limit_micro_usd)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (application_id, scope_kind, user_id) DO UPDATE SET
  limit_micro_usd = EXCLUDED.limit_micro_usd,
  updated_at = now()
RETURNING ${BUDGET_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.scopeKind,
        input.userId,
        input.limitMicroUsd,
      ],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "budget upsert returned no row" });
    }
    return toBudget(row);
  }

  async listBudgets(applicationId: string): Promise<readonly BudgetRecord[]> {
    const result = await this.exec.execute<BudgetRow>({
      sql: `SELECT ${BUDGET_COLUMNS} FROM budgets.budgets WHERE application_id = $1 ORDER BY id`,
      parameters: [applicationId],
    });
    return result.rows.map(toBudget);
  }

  async insertWallet(input: InsertWalletInput): Promise<WalletRecord | null> {
    const result = await this.exec.execute<WalletRow>({
      sql: `INSERT INTO budgets.wallets
  (id, application_id, tenant_id, owner_kind, owner_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (application_id, owner_kind, owner_id) DO NOTHING
RETURNING ${WALLET_COLUMNS}`,
      parameters: [input.id, input.applicationId, input.tenantId, input.ownerKind, input.ownerId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWallet(row);
  }

  async findWallet(
    applicationId: string,
    ownerKind: WalletOwnerKind,
    ownerId: string,
  ): Promise<WalletRecord | null> {
    const result = await this.exec.execute<WalletRow>({
      sql: `SELECT ${WALLET_COLUMNS} FROM budgets.wallets
WHERE application_id = $1 AND owner_kind = $2 AND owner_id = $3`,
      parameters: [applicationId, ownerKind, ownerId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWallet(row);
  }

  async listWallets(applicationId: string): Promise<readonly WalletRecord[]> {
    const result = await this.exec.execute<WalletRow>({
      sql: `SELECT ${WALLET_COLUMNS} FROM budgets.wallets WHERE application_id = $1 ORDER BY id`,
      parameters: [applicationId],
    });
    return result.rows.map(toWallet);
  }

  async creditWallet(
    walletId: string,
    applicationId: string,
    amountMicroUsd: MicroUsd,
  ): Promise<WalletRecord | null> {
    const result = await this.exec.execute<WalletRow>({
      sql: `UPDATE budgets.wallets
SET balance_micro_usd = balance_micro_usd + $3, updated_at = now()
WHERE id = $1 AND application_id = $2
RETURNING ${WALLET_COLUMNS}`,
      parameters: [walletId, applicationId, amountMicroUsd],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWallet(row);
  }

  async debitWallet(
    walletId: string,
    applicationId: string,
    amountMicroUsd: MicroUsd,
  ): Promise<WalletRecord | null> {
    // Atomic guard: the WHERE re-checks sufficiency inside the UPDATE, so a
    // racing draw cannot commit an overdraft (and the physical CHECK
    // balance_micro_usd >= 0 rejects even an unguarded attempt).
    const result = await this.exec.execute<WalletRow>({
      sql: `UPDATE budgets.wallets
SET balance_micro_usd = balance_micro_usd - $3, updated_at = now()
WHERE id = $1 AND application_id = $2 AND balance_micro_usd >= $3
RETURNING ${WALLET_COLUMNS}`,
      parameters: [walletId, applicationId, amountMicroUsd],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWallet(row);
  }

  async insertReservation(input: InsertReservationInput): Promise<ReservationRecord | null> {
    const result = await this.exec.execute<ReservationRow>({
      sql: `INSERT INTO budgets.reservations
  (id, application_id, tenant_id, execution_id, operation_id, user_id,
   funding_mode, source_kind, wallet_id, amount_micro_usd, month_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (application_id, operation_id) DO NOTHING
RETURNING ${RESERVATION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.operationId,
        input.userId,
        input.fundingMode,
        input.sourceKind,
        input.walletId,
        input.amountMicroUsd,
        input.monthKey,
      ],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReservation(row);
  }

  async findReservationByOperation(
    applicationId: string,
    operationId: string,
  ): Promise<ReservationRecord | null> {
    const result = await this.exec.execute<ReservationRow>({
      sql: `SELECT ${RESERVATION_COLUMNS} FROM budgets.reservations
WHERE application_id = $1 AND operation_id = $2`,
      parameters: [applicationId, operationId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReservation(row);
  }

  async lockReservation(
    applicationId: string,
    operationId: string,
  ): Promise<ReservationRecord | null> {
    const result = await this.exec.execute<ReservationRow>({
      sql: `SELECT ${RESERVATION_COLUMNS} FROM budgets.reservations
WHERE application_id = $1 AND operation_id = $2 FOR UPDATE`,
      parameters: [applicationId, operationId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReservation(row);
  }

  async finalizeReservationSettled(
    id: string,
    applicationId: string,
    settledAmountMicroUsd: MicroUsd,
  ): Promise<ReservationRecord | null> {
    const result = await this.exec.execute<ReservationRow>({
      sql: `UPDATE budgets.reservations
SET status = 'settled', settled_amount_micro_usd = $3, finalized_at = now()
WHERE id = $1 AND application_id = $2 AND status = 'active'
RETURNING ${RESERVATION_COLUMNS}`,
      parameters: [id, applicationId, settledAmountMicroUsd],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReservation(row);
  }

  async finalizeReservationReleased(
    id: string,
    applicationId: string,
  ): Promise<ReservationRecord | null> {
    const result = await this.exec.execute<ReservationRow>({
      sql: `UPDATE budgets.reservations
SET status = 'released', finalized_at = now()
WHERE id = $1 AND application_id = $2 AND status = 'active'
RETURNING ${RESERVATION_COLUMNS}`,
      parameters: [id, applicationId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toReservation(row);
  }

  async appendLedgerEntry(input: AppendLedgerEntryInput): Promise<LedgerEntryRecord> {
    const result = await this.exec.execute<LedgerRow>({
      sql: `INSERT INTO budgets.ledger_entries
  (id, application_id, tenant_id, wallet_id, reservation_id,
   entry_class, direction, amount_micro_usd, month_key, memo)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING ${LEDGER_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.walletId,
        input.reservationId,
        input.entryClass,
        input.direction,
        input.amountMicroUsd,
        input.monthKey,
        input.memo,
      ],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "ledger append returned no row" });
    }
    return toLedgerEntry(row);
  }

  async listLedgerEntriesByWallet(walletId: string): Promise<readonly LedgerEntryRecord[]> {
    const result = await this.exec.execute<LedgerRow>({
      sql: `SELECT ${LEDGER_COLUMNS} FROM budgets.ledger_entries
WHERE wallet_id = $1 ORDER BY occurred_at, id`,
      parameters: [walletId],
    });
    return result.rows.map(toLedgerEntry);
  }

  async usageForExecution(applicationId: string, executionId: string): Promise<MicroUsd> {
    const result = await this.exec.execute<{ total: string }>({
      sql: `SELECT COALESCE(SUM(
  CASE WHEN status = 'settled' THEN settled_amount_micro_usd ELSE amount_micro_usd END
), 0)::bigint AS total
FROM budgets.reservations
WHERE application_id = $1 AND execution_id = $2 AND status IN ('active', 'settled')`,
      parameters: [applicationId, executionId],
    });
    const row = first(result.rows);
    return (row?.total ?? "0") as MicroUsd;
  }

  async usageForMonth(applicationId: string, monthKey: string, userId?: string): Promise<MicroUsd> {
    const result = await this.exec.execute<{ total: string }>({
      sql: `SELECT COALESCE(SUM(
  CASE WHEN status = 'settled' THEN settled_amount_micro_usd ELSE amount_micro_usd END
), 0)::bigint AS total
FROM budgets.reservations
WHERE application_id = $1 AND month_key = $2 AND status IN ('active', 'settled')
  AND ($3::text IS NULL OR user_id = $3)`,
      parameters: [applicationId, monthKey, userId ?? null],
    });
    const row = first(result.rows);
    return (row?.total ?? "0") as MicroUsd;
  }
}

interface IdempotencyLedgerRow {
  readonly durable_outcome: unknown;
}

/**
 * Transaction-bound idempotency arbitration over
 * `platform.idempotency_records` — the exact durable contract of the
 * auth/applications/connections ledgers: the ledger row, the guarded
 * writes and the durable outcome commit in ONE transaction; concurrent
 * identical requests converge through the partial unique index
 * arbitration (the loser replays the winner's committed outcome).
 */
export class SqlBudgetsIdempotency implements BudgetsIdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly storeFactory: (tx: Transaction) => BudgetStore,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: BudgetsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: BudgetTx) => Promise<T>,
  ): Promise<BudgetsIdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      const txStore = this.storeFactory(tx);

      const inserted = await tx.execute<{ id: string }>({
        sql: `INSERT INTO platform.idempotency_records
  (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
VALUES ($1, $2, $3, $4, $5, $6, '"pending"'::jsonb)
ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
DO NOTHING
RETURNING id`,
        parameters: [
          this.generateId(),
          scope.actorId,
          scope.applicationId,
          operationName,
          idempotencyKey,
          requestFingerprint,
        ],
      });

      if (inserted.rows.length === 0) {
        // A previous request (committed, or committing concurrently — the
        // unique index arbitration makes this call wait for the winner)
        // already owns the key. Same fingerprint replays the durable
        // outcome; different fingerprint is key reuse.
        const existing = await tx.execute<IdempotencyLedgerRow & { request_fingerprint: string }>({
          sql: `SELECT durable_outcome, request_fingerprint FROM platform.idempotency_records
WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [scope.applicationId, operationName, idempotencyKey],
        });
        const row = first(existing.rows);
        if (row === undefined) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "idempotency key conflict disappeared during arbitration",
          });
        }
        if (row.request_fingerprint !== requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { operationName },
          });
        }
        return { outcome: row.durable_outcome as T, replayed: true };
      }

      const ledgerRow = first(inserted.rows);
      if (ledgerRow === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ledger insert returned no row",
        });
      }
      const outcome = await work({ store: txStore });
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerRow.id],
      });
      return { outcome, replayed: false };
    });
  }
}

/** Composition wiring: SQL store + arbitration + service over one DatabasePort. */
export function createSqlBudgetsModule(db: DatabasePort, generateId: () => string) {
  const store = new SqlBudgetStore(db);
  const idempotency = new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId);
  return { store, idempotency };
}
