-- DEP-014: sandbox governance — application quotas (budgets module) and
-- disposable sandbox identities (sandbox module).
--
-- Additive, forward-only. Quota rows enforce the fail-closed
-- check-and-increment at the row level (consumed <= limit CHECK); identity
-- rows carry the reset lineage with a partial unique index on supersedes
-- (one successor per predecessor — the physical idempotency backstop for
-- reset).

CREATE TABLE IF NOT EXISTS budgets.application_quotas (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    dimension      text NOT NULL
        CHECK (dimension IN ('spend-micro-usd', 'wall-clock-ms', 'concurrent-runs', 'artifact-count', 'artifact-bytes')),
    limit_value    bigint NOT NULL CHECK (limit_value >= 0),
    consumed       bigint NOT NULL DEFAULT 0 CHECK (consumed >= 0 AND consumed <= limit_value),
    window_kind    text NOT NULL
        CHECK (window_kind IN ('calendar-month', 'per-identity')),
    status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted')),
    identity_id    uuid,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- NULLS NOT DISTINCT: one live quota row per (application, dimension,
    -- identity) INCLUDING the shared null-identity row (the in-memory
    -- twin's single-key semantics; PG16+).
    UNIQUE NULLS NOT DISTINCT (application_id, dimension, identity_id)
);

CREATE INDEX IF NOT EXISTS application_quotas_scope_idx
    ON budgets.application_quotas (application_id, tenant_id);

CREATE TABLE IF NOT EXISTS sandbox.identities (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    environment_id uuid,
    status         text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'quota-exhausted', 'reset')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    superseded_by  uuid,
    supersedes     uuid
);

-- One successor per predecessor: the physical reset-idempotency backstop
-- (a second reset of the same identity cannot insert a second successor).
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_identities_supersedes_uidx
    ON sandbox.identities (supersedes) WHERE supersedes IS NOT NULL;

CREATE INDEX IF NOT EXISTS sandbox_identities_scope_idx
    ON sandbox.identities (application_id, tenant_id);
