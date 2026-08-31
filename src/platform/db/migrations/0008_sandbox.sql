-- WORK-012 — Compute environments and sandbox manager.
--
-- The durable state of the sandbox axis (ENV-001/ENV-002): the
-- provider-neutral compute-environment catalog (immutable specifications +
-- a small lifecycle) and the sandbox-executions journal (idempotent
-- admission rows carrying the IMMUTABLE runtime metadata — criterion 4 —
-- journal-then-fail denial rows, the one-shot dispatch claim and the
-- terminal-immutable outcome rows).
--
-- Physical invariants enforced here (the WORK-004/0004/0005/0006
-- discipline of making violations UNREPRESENTABLE, not merely
-- discouraged):
--
--   * environment identity is UNIQUE (application_id, slug): duplicate
--     registrations converge through the unique-index arbitration;
--     specifications are WRITE-ONCE (a physical trigger rejects any
--     UPDATE that would change the spec/kind/digest — the ONLY mutation
--     is the guarded lifecycle status); rows are never deleted;
--   * the environment lifecycle vocabulary is CHECK-bound
--     (available/suspended/retired) with terminal retired rows
--     physically immutable;
--   * sandbox identity is UNIQUE (application_id, sandbox_key):
--     concurrent duplicate admission converges on ONE durable identity
--     (M11); same key + different fingerprint is rejected in the service
--     (IDEMPOTENCY_KEY_REUSED) before any write;
--   * runtime_metadata is IMMUTABLE on every UPDATE path (physical
--     trigger — the dispatched work is always the admitted work, M13);
--   * the OUTCOME vocabulary is the SANDBOX AXIS ONLY — outcome_class ∈
--     {sandbox-success, sandbox-failure} or NULL; verification
--     (PASS/FAIL/INCONCLUSIVE), provider and tool classes are
--     UNREPRESENTABLE here;
--   * denial classes are the three admission authorities (policy |
--     budget | capability); failure classes are the sandbox axis; both
--     CHECK-bound;
--   * status/outcome shape consistency is pinned: denied rows carry
--     denial fields and no outcome; admitted rows carry runtime metadata
--     and no outcome/dispatch fields; dispatching rows carry dispatch
--     intent; completed/failed rows carry the outcome + timing + ledger
--     binding;
--   * rows are NEVER deleted; terminal rows (denied | completed |
--     failed) are PHYSICALLY immutable; the only legal UPDATE paths are:
--     admitted rows (ledger-sequence bookkeeping, the one-shot
--     admitted → dispatching claim) and dispatching rows (the one-shot
--     dispatching → completed | failed finalization);
--   * tenant scoping uses composite FKs like migrations 0002/0003/0004/
--     0005/0006: (application_id, tenant_id) -> applications.applications,
--     (execution_id, application_id) -> executions.executions and
--     (environment_id, application_id) -> sandbox.compute_environments —
--     cross-tenant, cross-application and cross-environment sandbox rows
--     are unrepresentable (M9/M10/M12).
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE SCHEMA sandbox;

-- ---------------------------------------------------------------------------
-- Compute environments (owned by the sandbox module): the immutable
-- provider-neutral environment catalog. NOT a state machine — the
-- execution lifecycle authority stays in executions.executions.
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.compute_environments (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    slug          text NOT NULL,
    name          text NOT NULL,
    description   text,
    kind          text NOT NULL,
    spec          jsonb NOT NULL,
    spec_digest   text NOT NULL,
    status        text NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT compute_environments_kind_vocabulary CHECK (
        kind IN ('no-execution', 'process', 'container', 'microvm', 'vm', 'customer-runner')
    ),
    CONSTRAINT compute_environments_status_vocabulary CHECK (status IN ('available', 'suspended', 'retired')),
    CONSTRAINT compute_environments_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT compute_environments_identity_key UNIQUE (application_id, slug),
    -- composite FK target for sandbox executions (scope-carrying reference)
    CONSTRAINT compute_environments_scope_key UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX compute_environments_catalog
    ON sandbox.compute_environments (application_id, tenant_id, status);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION sandbox.compute_environments_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.compute_environments rows are never deleted (environment %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER compute_environments_no_delete
    BEFORE DELETE ON sandbox.compute_environments
    FOR EACH ROW EXECUTE FUNCTION sandbox.compute_environments_no_delete();

-- Specifications are write-once artifacts: the ONLY legal mutation is the
-- lifecycle status (+ updated_at). Any change to identity, specification
-- or digest is physically rejected (M13-class immutability).
CREATE OR REPLACE FUNCTION sandbox.compute_environments_immutable_spec() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.slug <> OLD.slug OR NEW.name <> OLD.name OR NEW.description IS DISTINCT FROM OLD.description OR NEW.kind <> OLD.kind OR NEW.spec IS DISTINCT FROM OLD.spec OR NEW.spec_digest <> OLD.spec_digest OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'sandbox.compute_environments specification is immutable (environment %); register a new environment instead', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER compute_environments_immutable_spec_guard
    BEFORE UPDATE ON sandbox.compute_environments
    FOR EACH ROW EXECUTE FUNCTION sandbox.compute_environments_immutable_spec();

-- Retired is terminal-immutable.
CREATE OR REPLACE FUNCTION sandbox.compute_environments_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status = 'retired' THEN RAISE EXCEPTION 'sandbox.compute_environments is terminal-immutable in state retired (environment %)', OLD.id; END IF; IF NOT ((OLD.status = 'available' AND NEW.status IN ('suspended', 'retired')) OR (OLD.status = 'suspended' AND NEW.status IN ('available', 'retired'))) THEN RAISE EXCEPTION 'compute environment % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER compute_environments_lifecycle_guard
    BEFORE UPDATE ON sandbox.compute_environments
    FOR EACH ROW EXECUTE FUNCTION sandbox.compute_environments_lifecycle();

-- ---------------------------------------------------------------------------
-- Sandbox executions (owned by the sandbox module): the governed
-- admission/dispatch/outcome journal. NOT a state machine — subordinate
-- bookkeeping on the sandbox axis; the execution lifecycle authority
-- stays in executions.executions (evidence rides the executions ledger
-- as step events through the executions public service).
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.sandbox_executions (
    id                     uuid PRIMARY KEY,
    application_id         uuid NOT NULL,
    tenant_id              uuid NOT NULL,
    execution_id           uuid NOT NULL,
    sandbox_key            text NOT NULL,
    request_fingerprint    text NOT NULL,
    environment_id         uuid NOT NULL,
    kind                   text NOT NULL,
    status                 text NOT NULL,
    runtime_metadata       jsonb NOT NULL,
    denial_class           text,
    denial_code            text,
    denial_reason          text,
    outcome_class          text,
    failure_class          text,
    failure_message        text,
    retryable              boolean NOT NULL DEFAULT false,
    output_digest          text,
    usage_micro_usd        text,
    budget_operation_id    text,
    ledger_admitted_sequence integer,
    ledger_completed_sequence integer,
    created_at             timestamptz NOT NULL,
    dispatched_at          timestamptz,
    completed_at           timestamptz,
    duration_ms            integer,
    CONSTRAINT sandbox_executions_status_vocabulary CHECK (
        status IN ('denied', 'admitted', 'dispatching', 'completed', 'failed')
    ),
    CONSTRAINT sandbox_executions_kind_vocabulary CHECK (
        kind IN ('no-execution', 'process', 'container', 'microvm', 'vm', 'customer-runner')
    ),
    -- THE sandbox-axis outcome vocabulary: verification classes (PASS /
    -- FAIL / INCONCLUSIVE), provider-axis and tool-axis classes are
    -- physically excluded.
    CONSTRAINT sandbox_executions_outcome_vocabulary CHECK (
        outcome_class IS NULL OR outcome_class IN ('sandbox-success', 'sandbox-failure')
    ),
    CONSTRAINT sandbox_executions_denial_vocabulary CHECK (
        denial_class IS NULL OR denial_class IN ('policy', 'budget', 'capability')
    ),
    CONSTRAINT sandbox_executions_denial_code_vocabulary CHECK (
        denial_code IS NULL OR denial_code IN ('POLICY_DENIED', 'BUDGET_EXCEEDED', 'CAPABILITY_UNAVAILABLE')
    ),
    CONSTRAINT sandbox_executions_failure_vocabulary CHECK (
        failure_class IS NULL OR failure_class IN (
            'sandbox-execution', 'timeout', 'adapter-error', 'runtime-unavailable'
        )
    ),
    -- Shape consistency per status (denial/outcome disjointness).
    CONSTRAINT sandbox_executions_denied_shape CHECK (
        (status = 'denied') = (denial_class IS NOT NULL AND denial_code IS NOT NULL)
    ),
    CONSTRAINT sandbox_executions_admitted_shape CHECK (
        status <> 'admitted' OR (outcome_class IS NULL AND denial_class IS NULL AND failure_class IS NULL AND dispatched_at IS NULL AND completed_at IS NULL)
    ),
    CONSTRAINT sandbox_executions_dispatching_shape CHECK (
        status <> 'dispatching' OR (outcome_class IS NULL AND denial_class IS NULL AND failure_class IS NULL AND completed_at IS NULL AND dispatched_at IS NOT NULL)
    ),
    CONSTRAINT sandbox_executions_outcome_shape CHECK (
        (status IN ('completed', 'failed')) = (outcome_class IS NOT NULL AND completed_at IS NOT NULL AND dispatched_at IS NOT NULL)
    ),
    CONSTRAINT sandbox_executions_completed_shape CHECK (
        status <> 'completed' OR (outcome_class = 'sandbox-success' AND failure_class IS NULL)
    ),
    CONSTRAINT sandbox_executions_failed_shape CHECK (
        status <> 'failed' OR (outcome_class = 'sandbox-failure' AND failure_class IS NOT NULL)
    ),
    CONSTRAINT sandbox_executions_outcome_never_denied CHECK (
        denial_class IS NULL OR (outcome_class IS NULL AND failure_class IS NULL)
    ),
    CONSTRAINT sandbox_executions_usage_shape CHECK (
        usage_micro_usd IS NULL OR usage_micro_usd ~ '^\d{1,19}$'
    ),
    CONSTRAINT sandbox_executions_duration_shape CHECK (
        duration_ms IS NULL OR duration_ms >= 0
    ),
    CONSTRAINT sandbox_executions_ledger_sequences CHECK (
        (ledger_admitted_sequence IS NULL OR ledger_admitted_sequence >= 1)
        AND (ledger_completed_sequence IS NULL OR ledger_completed_sequence >= 1)
    ),
    CONSTRAINT sandbox_executions_identities_nonempty CHECK (
        length(sandbox_key) BETWEEN 1 AND 200
        AND length(request_fingerprint) BETWEEN 1 AND 500
    ),
    CONSTRAINT sandbox_executions_metadata_shape CHECK (
        jsonb_typeof(runtime_metadata) = 'object'
    ),
    CONSTRAINT sandbox_executions_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT sandbox_executions_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT sandbox_executions_environment_fk
        FOREIGN KEY (environment_id, application_id)
        REFERENCES sandbox.compute_environments (id, application_id),
    -- The request idempotency anchor: one durable row per logical sandbox.
    CONSTRAINT sandbox_executions_request_key UNIQUE (application_id, sandbox_key)
);

CREATE INDEX sandbox_executions_by_execution
    ON sandbox.sandbox_executions (application_id, execution_id, created_at);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION sandbox.sandbox_executions_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.sandbox_executions rows are never deleted (sandbox %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER sandbox_executions_no_delete
    BEFORE DELETE ON sandbox.sandbox_executions
    FOR EACH ROW EXECUTE FUNCTION sandbox.sandbox_executions_no_delete();

-- Runtime metadata is immutable on EVERY update path (the dispatched work
-- is always the admitted work — M13).
CREATE OR REPLACE FUNCTION sandbox.sandbox_executions_immutable_metadata() RETURNS trigger AS $$ BEGIN IF NEW.runtime_metadata IS DISTINCT FROM OLD.runtime_metadata OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.execution_id <> OLD.execution_id OR NEW.environment_id <> OLD.environment_id OR NEW.kind <> OLD.kind OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'sandbox.sandbox_executions runtime metadata and identity are immutable (sandbox %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER sandbox_executions_immutable_metadata_guard
    BEFORE UPDATE ON sandbox.sandbox_executions
    FOR EACH ROW EXECUTE FUNCTION sandbox.sandbox_executions_immutable_metadata();

-- Terminal rows are physically immutable; the only legal UPDATE paths are:
-- admitted rows (ledger bookkeeping / the one-shot dispatch claim) and
-- dispatching rows (the one-shot finalization). denied is insert-only.
CREATE OR REPLACE FUNCTION sandbox.sandbox_executions_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('denied', 'completed', 'failed') THEN RAISE EXCEPTION 'sandbox.sandbox_executions is terminal-immutable in state % (sandbox %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'admitted' AND NEW.status IN ('admitted', 'dispatching')) OR (OLD.status = 'dispatching' AND NEW.status IN ('dispatching', 'completed', 'failed'))) THEN RAISE EXCEPTION 'sandbox execution % cannot move from status % to % (denied is insert-only; admitted claims dispatching; dispatching finalizes to completed/failed)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER sandbox_executions_lifecycle_guard
    BEFORE UPDATE ON sandbox.sandbox_executions
    FOR EACH ROW EXECUTE FUNCTION sandbox.sandbox_executions_lifecycle();
