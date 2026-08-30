-- WORK-004 — Budgets, wallets, reservations and ledger.
--
-- Durable schema for funding wallets, application funding policy, budget
-- limits, concurrency-safe reservations and the APPEND-ONLY settlement
-- ledger (`spec/requirements.md` BUD-001..BUD-005, `spec/architecture.md`
-- §17, `IMPLEMENTATION.md` §8).
--
-- Invariants encoded here:
--   * money is INTEGER MINOR UNITS ONLY — `bigint` micro-USD; floating
--     point and non-integer amounts are unrepresentable (no numeric/real
--     column carries money anywhere in this schema);
--   * wallet balances are never negative (CHECK) — a racing double-draw is
--     physically rejected even if a service-level guard were removed;
--   * every ownership-bearing row carries an explicit `tenant_id` and
--     references its application through the COMPOSITE key
--     (application_id, tenant_id) (WORK-002 anti-ambiguity pattern);
--   * reservations/wallet draws are application-scoped by construction:
--     wallets are UNIQUE (id, application_id) and reservations/ledger rows
--     reference wallets through (wallet_id, application_id) — drawing from
--     another application's wallet is unrepresentable;
--   * a reservation's funding shape is CHECK-constrained: `byok` holds no
--     wallet, every wallet-funded source holds exactly one wallet row;
--   * reservation finalization is shape-constrained: only `active` rows
--     may finalize; `settled` carries exactly one non-negative actual
--     amount and a finalization timestamp, `released` carries neither
--     amount nor... (see constraint comments);
--   * the ledger is PHYSICALLY append-only: BEFORE UPDATE OR DELETE raises
--     an exception (trigger below); every money movement class is bound to
--     its direction by CHECK; corrections are their own entry class.
--
-- Migration-runner note: the trigger function body is written on a single
-- line because the runner splits statements on `;` at end of line
-- (`src/platform/db/migrations/runner.ts` `splitStatements`) — embedded
-- semicolons must never end a line inside this file.

CREATE SCHEMA IF NOT EXISTS budgets;

-- ---------------------------------------------------------------------------
-- Funding wallets (owned by the budgets module).
--
-- One wallet per funding source per application: developer funds, a specific
-- end user's funds, or platform subsidy credits. BYOK is NOT a wallet (the
-- customer's own provider credential pays the provider); BYOK accounting
-- lives on the reservation rows only.
--
-- `owner_id` discriminates the end-user wallet; the sentinel '' is used for
-- application-level wallets so the UNIQUE key stays NULL-free (PostgreSQL
-- UNIQUE treats NULLs as distinct, which would allow duplicate developer
-- wallets).
-- ---------------------------------------------------------------------------

CREATE TABLE budgets.wallets (
    id                uuid PRIMARY KEY,
    application_id    uuid NOT NULL,
    tenant_id         uuid NOT NULL,
    owner_kind        text NOT NULL,
    owner_id          text NOT NULL DEFAULT '',
    currency          text NOT NULL DEFAULT 'usd-micro',
    balance_micro_usd bigint NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wallets_owner_kind CHECK (owner_kind IN ('developer', 'user', 'subsidy')),
    CONSTRAINT wallets_currency CHECK (currency = 'usd-micro'),
    CONSTRAINT wallets_balance_never_negative CHECK (balance_micro_usd >= 0),
    CONSTRAINT wallets_owner_shape CHECK (
        (owner_kind = 'user' AND length(owner_id) BETWEEN 1 AND 255)
        OR (owner_kind IN ('developer', 'subsidy') AND owner_id = '')
    ),
    -- Anti-ambiguity: a wallet's tenant must be its application's tenant.
    CONSTRAINT wallets_application_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- One wallet per funding source per application.
    CONSTRAINT wallets_source_unique UNIQUE (application_id, owner_kind, owner_id),
    -- Draw-target anti-ambiguity: (id, application_id) pairs with exactly
    -- one wallet, so reservations/ledger rows below can reference a wallet
    -- AND pin its application in a single composite FK.
    CONSTRAINT wallets_id_application_unique UNIQUE (id, application_id)
);

CREATE INDEX wallets_by_application ON budgets.wallets (application_id, tenant_id);

-- ---------------------------------------------------------------------------
-- Application funding policy (owned by the budgets module).
--
-- The application-level funding MODE the reservation evaluator consults
-- (BUD-003): 'developer' | 'user' | 'byok' | 'hybrid' | 'subsidy'.
--
-- This row is also the SERIALIZATION PIVOT of the reservation decision
-- domain: `lockDecisionDomain` takes this row's FOR UPDATE lock FIRST, so
-- every budget/reserve writer of an application totally orders (WORK-002
-- lock-the-full-decision-domain discipline). Reservations against an
-- application with NO policy row fail closed (POLICY_DENIED) — which also
-- guarantees the pivot row exists whenever a decision is being made.
-- ---------------------------------------------------------------------------

CREATE TABLE budgets.application_funding_settings (
    application_id   uuid PRIMARY KEY,
    tenant_id        uuid NOT NULL,
    funding_mode     text NOT NULL,
    allow_user_limits boolean NOT NULL DEFAULT true,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT funding_mode_vocabulary CHECK (funding_mode IN ('developer', 'user', 'byok', 'hybrid', 'subsidy')),
    CONSTRAINT funding_settings_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Budget limits (owned by the budgets module; BUD-001/BUD-002).
--
--   per-execution — cap on the committed spend (holds + settled actuals)
--                   accumulated under one logical execution
--                   (`reservations.execution_id`, the execution identity
--                   WORK-006 will pass);
--   monthly       — cap on the committed spend of the whole application
--                   within one deterministic UTC calendar-month window
--                   (`reservations.month_key`, 'YYYY-MM' of reservation
--                   creation);
--   user-monthly  — an end user's own monthly spending limit, enforced
--                   only where the application permits user limits
--                   (`application_funding_settings.allow_user_limits`,
--                   BUD-002).
--
-- Evaluation precedence is deterministic and frozen in the domain layer:
-- per-execution -> monthly -> user-monthly (first failing check is THE
-- denial reason). One limit row per (application, scope, user).
-- ---------------------------------------------------------------------------

CREATE TABLE budgets.budgets (
    id               uuid PRIMARY KEY,
    application_id   uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    scope_kind       text NOT NULL,
    user_id          text NOT NULL DEFAULT '',
    limit_micro_usd  bigint NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT budgets_scope_kind CHECK (scope_kind IN ('per-execution', 'monthly', 'user-monthly')),
    CONSTRAINT budgets_limit_positive CHECK (limit_micro_usd > 0),
    CONSTRAINT budgets_scope_shape CHECK (
        (scope_kind = 'user-monthly' AND length(user_id) BETWEEN 1 AND 255)
        OR (scope_kind IN ('per-execution', 'monthly') AND user_id = '')
    ),
    CONSTRAINT budgets_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT budgets_scope_unique UNIQUE (application_id, scope_kind, user_id)
);

-- ---------------------------------------------------------------------------
-- Reservations (owned by the budgets module; BUD-004).
--
-- One row per LOGICAL BILLABLE OPERATION: UNIQUE (application_id,
-- operation_id) makes a double hold for the same logical operation
-- unrepresentable — a racing second writer converges on this row (ON
-- CONFLICT DO NOTHING + re-read) instead of creating a second hold.
--
-- Lifecycle: active -> settled (settle, exactly once, with the actual
-- usage amount) | active -> released (release of an unused hold, exactly
-- once). Both transitions are terminal; the shape CHECK below pins the
-- terminal payloads. Budget aggregates count holds at their reserved
-- amount and settled rows at their ACTUAL amount (settled usage is the
-- truth, holds are the conservative admission estimate).
-- ---------------------------------------------------------------------------

CREATE TABLE budgets.reservations (
    id                         uuid PRIMARY KEY,
    application_id             uuid NOT NULL,
    tenant_id                  uuid NOT NULL,
    execution_id               text NOT NULL,
    operation_id               text NOT NULL,
    user_id                    text NOT NULL DEFAULT '',
    funding_mode               text NOT NULL,
    source_kind                text NOT NULL,
    wallet_id                  uuid,
    amount_micro_usd           bigint NOT NULL,
    status                     text NOT NULL DEFAULT 'active',
    settled_amount_micro_usd   bigint,
    month_key                  text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    finalized_at               timestamptz,
    CONSTRAINT reservations_status CHECK (status IN ('active', 'settled', 'released')),
    CONSTRAINT reservations_source_kind CHECK (source_kind IN ('developer', 'user', 'subsidy', 'byok')),
    CONSTRAINT reservations_funding_mode CHECK (funding_mode IN ('developer', 'user', 'byok', 'hybrid', 'subsidy')),
    CONSTRAINT reservations_amount_positive CHECK (amount_micro_usd > 0),
    CONSTRAINT reservations_month_key_format CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    -- Funding shape: BYOK holds no wallet; wallet-funded sources hold one.
    CONSTRAINT reservations_funding_shape CHECK (
        (source_kind = 'byok' AND wallet_id IS NULL)
        OR (source_kind IN ('developer', 'user', 'subsidy') AND wallet_id IS NOT NULL)
    ),
    -- Terminal shape: only settled rows carry an actual amount + timestamp.
    CONSTRAINT reservations_lifecycle_shape CHECK (
        (status = 'active' AND settled_amount_micro_usd IS NULL AND finalized_at IS NULL)
        OR (status = 'settled' AND settled_amount_micro_usd IS NOT NULL AND settled_amount_micro_usd >= 0 AND finalized_at IS NOT NULL)
        OR (status = 'released' AND settled_amount_micro_usd IS NULL AND finalized_at IS NOT NULL)
    ),
    CONSTRAINT reservations_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- Draw anti-ambiguity: the wallet drawn from belongs to THIS application.
    CONSTRAINT reservations_wallet_fk
        FOREIGN KEY (wallet_id, application_id)
        REFERENCES budgets.wallets (id, application_id),
    -- One reservation per logical billable operation (no double hold).
    CONSTRAINT reservations_operation_unique UNIQUE (application_id, operation_id)
);

CREATE INDEX reservations_by_execution ON budgets.reservations (application_id, execution_id);
CREATE INDEX reservations_by_month ON budgets.reservations (application_id, month_key);

-- ---------------------------------------------------------------------------
-- Settlement ledger (owned by the budgets module; BUD-005).
--
-- PHYSICALLY APPEND-ONLY: the trigger below rejects every UPDATE and DELETE
-- on this table at the PostgreSQL level; corrections are NEW entries of
-- class 'correction'. Every money movement is one entry:
--
--   reservation-hold    debit   hold placed for a reservation
--   settle-overage      debit   actual usage exceeded the hold
--   settle-release      credit  unused hold returned at settlement
--   reservation-release credit  unused hold returned (cancellation)
--   credit-grant        credit  funds granted into a wallet
--   correction          either  compensating correction (append-only)
--
-- The SUM(debits) - SUM(credits) of a wallet's entries always equals the
-- wallet's live `balance_micro_usd` (both are written in the same
-- transaction); the ledger is the durable audit trail, the wallet row the
-- live balance — one authority, not a second state machine.
-- ---------------------------------------------------------------------------

CREATE TABLE budgets.ledger_entries (
    id                uuid PRIMARY KEY,
    application_id    uuid NOT NULL,
    tenant_id         uuid NOT NULL,
    wallet_id         uuid NOT NULL,
    reservation_id    uuid,
    entry_class       text NOT NULL,
    direction         text NOT NULL,
    amount_micro_usd  bigint NOT NULL,
    month_key         text NOT NULL,
    memo              text,
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entry_class CHECK (entry_class IN ('reservation-hold', 'settle-overage', 'settle-release', 'reservation-release', 'credit-grant', 'correction')),
    CONSTRAINT ledger_direction CHECK (direction IN ('debit', 'credit')),
    CONSTRAINT ledger_amount_positive CHECK (amount_micro_usd > 0),
    CONSTRAINT ledger_month_key_format CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    -- Movement classes are bound to their direction; only corrections may
    -- carry either.
    CONSTRAINT ledger_class_direction CHECK (
        (entry_class IN ('reservation-hold', 'settle-overage') AND direction = 'debit')
        OR (entry_class IN ('settle-release', 'reservation-release', 'credit-grant') AND direction = 'credit')
        OR (entry_class = 'correction')
    ),
    CONSTRAINT ledger_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- Movement anti-ambiguity: the entry's wallet belongs to THIS application.
    CONSTRAINT ledger_wallet_fk
        FOREIGN KEY (wallet_id, application_id)
        REFERENCES budgets.wallets (id, application_id),
    CONSTRAINT ledger_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES budgets.reservations (id)
);

CREATE INDEX ledger_by_wallet ON budgets.ledger_entries (wallet_id, occurred_at);
CREATE INDEX ledger_by_reservation ON budgets.ledger_entries (reservation_id);

-- Physical append-only enforcement. Single line: the migration runner
-- splits statements on ';'-at-end-of-line and this body must stay intact.
CREATE OR REPLACE FUNCTION budgets.ledger_entries_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'budgets.ledger_entries is append-only (rejected % on entry %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_mutation
    BEFORE UPDATE OR DELETE ON budgets.ledger_entries
    FOR EACH ROW EXECUTE FUNCTION budgets.ledger_entries_append_only();

-- Terminal reservations are physically immutable: a row may move
-- active -> settled|released exactly once and never back or sideways, and
-- reservation rows are never deleted (usage aggregates and ledger linkage
-- must survive); a double settle/release or a history-erasing delete is
-- unrepresentable at the row level even if every service-level guard were
-- removed (payload shapes while active are pinned by the lifecycle CHECK
-- below). Single line (migration runner rule).
CREATE OR REPLACE FUNCTION budgets.reservations_forward_only() RETURNS trigger AS $$ BEGIN IF TG_OP = 'DELETE' OR OLD.status <> 'active' THEN RAISE EXCEPTION 'budgets.reservations finalize exactly once (rejected % on reservation %)', TG_OP, OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_finalize_once
    BEFORE UPDATE OR DELETE ON budgets.reservations
    FOR EACH ROW EXECUTE FUNCTION budgets.reservations_forward_only();
