-- WORK-019 — MicroVM/VM execution fleet and customer runners (ENV-003).
--
-- The durable state of the runner fleet: the customer-runner identity
-- registry (explicit registration, explicit authorization, observed
-- health/connection), the assignment journal (idempotent per assignment
-- key, EXCLUSIVELY leased per runner, guarded one-shot transitions) and
-- the append-only assignment evidence trail (the provenance that survives
-- disconnects and reconnects).
--
-- AUTHORITY PRESERVATION (the Work Order's critical architecture rule):
--   * a runner is an execution SUBSTRATE, not a new authority: assignment
--     rows anchor the ALREADY-ADMITTED sandbox execution (composite FKs to
--     sandbox.sandbox_executions and executions.executions — a runner can
--     never fabricate or fork an execution identity); the execution
--     lifecycle state machine stays in executions.executions and NO
--     execution status vocabulary exists in these tables;
--   * registration is NOT trust: authorization_status starts 'untrusted'
--     (the column DEFAULT) and only an explicit guarded transition grants
--     'authorized'; 'revoked' is terminal-immutable (a re-authorization is
--     never representable — register a new runner); health starts
--     'unknown' and connection starts 'offline' (observed, not claimed);
--   * external identity is not authorization: the runner carries a hashed
--     token FINGERPRINT (never the token); no table stores a credential;
--   * capability declarations are DESCRIPTIVE (the runner vocabulary is
--     CHECK-bound); what a runner may DO is still decided by the policy/
--     capability authorities at sandbox admission.
--
-- Physical invariants (violations are UNREPRESENTABLE, the 0004/0005/
-- 0006/0008 discipline):
--   * runner identity is UNIQUE (application_id, slug): duplicate
--     registrations converge through unique-index arbitration; the
--     identity core (environment, version, capabilities, token
--     fingerprint, provenance) is WRITE-ONCE (a physical trigger rejects
--     any UPDATE that would change it); rows are never deleted; revoked
--     rows are terminal-immutable (only health/connection observation and
--     the authorization transitions may mutate);
--   * assignment identity is UNIQUE (application_id, assignment_key):
--     concurrent duplicate assignments converge on ONE durable row (the
--     idempotency anchor);
--   * ONE ACTIVE ASSIGNMENT PER RUNNER: a partial unique index on
--     (runner_id) WHERE status IN ('assigned','dispatched') makes
--     split-brain runner ownership unrepresentable (the release/assignment
--     race can never leave two active assignments);
--   * terminal assignment rows (completed | failed | released | expired)
--     are PHYSICALLY immutable; the only legal UPDATE paths are the
--     one-shot transitions (assigned -> dispatched; assigned/dispatched ->
--     completed/failed/released/expired) and reconnect bookkeeping
--     (reconnect_count) on dispatched rows;
--   * the assignment insert guard lives in the ADAPTER statement
--     (authorization + health + heartbeat freshness evaluated in the same
--     INSERT ... SELECT); the CHECK constraints here keep the shape
--     consistent (lease shape, outcome/dispatch/reconnect shapes, status
--     vocabulary disjoint from every execution status);
--   * assignment events are APPEND-ONLY (no UPDATE, no DELETE — triggers)
--     with a per-assignment monotonic sequence (UNIQUE (assignment_id,
--     sequence)): the provenance trail survives reconnects (M18);
--   * tenant scoping uses composite FKs: (application_id, tenant_id) ->
--     applications.applications, (sandbox_id, application_id) ->
--     sandbox.sandbox_executions, (execution_id, application_id) ->
--     executions.executions, (environment_id, application_id) ->
--     sandbox.compute_environments, (runner_id, application_id) ->
--     sandbox.runners — cross-tenant, cross-application, cross-sandbox and
--     cross-environment assignment rows are unrepresentable.
--
-- Migration-version discipline (the collision rule, parallel wave — see
-- docs/work-items/WORK-018.md "Migration discipline"): the live inventory
-- at authoring time is 0001..0014 (all merged on main); the sibling
-- branch claims 0016 (WORK-022, pushed in the same wave). The wave
-- pre-assigned numbers by dispatch order: **WORK-019 claims 0015 (THIS
-- migration)**. No other unmerged Work Order claims any number; 0016
-- arrives with the sibling's merge and file gaps are legal pre-merge
-- (the runner applies in ascending order and allows gaps).
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

-- ---------------------------------------------------------------------------
-- Runners (owned by the sandbox module): the customer-runner identity
-- registry. NOT a state machine over executions — substrate bookkeeping.
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.runners (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    environment_id uuid NOT NULL,
    slug          text NOT NULL,
    name          text NOT NULL,
    runner_version text NOT NULL,
    declared_capabilities jsonb NOT NULL,
    token_fingerprint text NOT NULL,
    provenance    jsonb NOT NULL,
    authorization_status text NOT NULL DEFAULT 'untrusted',
    authorized_at timestamptz,
    authorized_by_actor_id text,
    revoked_at    timestamptz,
    revocation_reason text,
    health_status text NOT NULL DEFAULT 'unknown',
    last_heartbeat_at timestamptz,
    connection_status text NOT NULL DEFAULT 'offline',
    last_connected_at timestamptz,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT runners_authorization_vocabulary CHECK (authorization_status IN ('untrusted', 'authorized', 'revoked')),
    CONSTRAINT runners_health_vocabulary CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unhealthy')),
    CONSTRAINT runners_connection_vocabulary CHECK (connection_status IN ('offline', 'connected', 'disconnected')),
    CONSTRAINT runners_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT runners_version_shape CHECK (runner_version ~ '^\d+\.\d+\.\d+$'),
    CONSTRAINT runners_token_fingerprint_shape CHECK (length(token_fingerprint) BETWEEN 16 AND 128),
    CONSTRAINT runners_authorized_shape CHECK (
        (authorization_status = 'authorized') = (authorized_at IS NOT NULL AND authorized_by_actor_id IS NOT NULL)
    ),
    CONSTRAINT runners_revoked_shape CHECK (
        (authorization_status = 'revoked') = (revoked_at IS NOT NULL)
    ),
    CONSTRAINT runners_capabilities_shape CHECK (
        jsonb_typeof(declared_capabilities) = 'array'
        AND jsonb_array_length(declared_capabilities) BETWEEN 1 AND 16
        AND declared_capabilities <@ '["cpu","memory","filesystem","network","gpu","microvm","vm","customer-runner"]'::jsonb
    ),
    CONSTRAINT runners_identity_key UNIQUE (application_id, slug),
    CONSTRAINT runners_scope_key UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT runners_environment_fk
        FOREIGN KEY (environment_id, application_id)
        REFERENCES sandbox.compute_environments (id, application_id)
);

CREATE INDEX runners_catalog
    ON sandbox.runners (application_id, environment_id, authorization_status, health_status);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION sandbox.runners_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.runners rows are never deleted (runner %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runners_no_delete
    BEFORE DELETE ON sandbox.runners
    FOR EACH ROW EXECUTE FUNCTION sandbox.runners_no_delete();

-- The identity core is WRITE-ONCE: only the authorization transitions and
-- the health/connection observations may mutate a runner row. Revoked rows
-- are terminal-immutable (a re-authorization is unrepresentable — register
-- a new runner).
CREATE OR REPLACE FUNCTION sandbox.runners_immutable_identity() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.environment_id <> OLD.environment_id OR NEW.slug <> OLD.slug OR NEW.name <> OLD.name OR NEW.runner_version <> OLD.runner_version OR NEW.declared_capabilities IS DISTINCT FROM OLD.declared_capabilities OR NEW.token_fingerprint <> OLD.token_fingerprint OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'sandbox.runners identity core is immutable (runner %); register a new runner instead', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runners_immutable_identity_guard
    BEFORE UPDATE ON sandbox.runners
    FOR EACH ROW EXECUTE FUNCTION sandbox.runners_immutable_identity();

CREATE OR REPLACE FUNCTION sandbox.runners_authorization_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.authorization_status = 'revoked' THEN RAISE EXCEPTION 'sandbox.runners is terminal-immutable in authorization state revoked (runner %)', OLD.id; END IF; IF NOT ((OLD.authorization_status = NEW.authorization_status) OR (OLD.authorization_status = 'untrusted' AND NEW.authorization_status IN ('authorized', 'revoked')) OR (OLD.authorization_status = 'authorized' AND NEW.authorization_status = 'revoked')) THEN RAISE EXCEPTION 'runner % cannot move authorization from % to % (register a new runner instead of re-authorizing a revoked one)', OLD.id, OLD.authorization_status, NEW.authorization_status; END IF; IF OLD.authorization_status = NEW.authorization_status AND (OLD.authorized_at IS DISTINCT FROM NEW.authorized_at OR OLD.authorized_by_actor_id IS DISTINCT FROM NEW.authorized_by_actor_id OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.revocation_reason IS DISTINCT FROM NEW.revocation_reason) THEN RAISE EXCEPTION 'runner % authorization facts are immutable within the state % (only the explicit transitions change them)', OLD.id, OLD.authorization_status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runners_authorization_lifecycle_guard
    BEFORE UPDATE ON sandbox.runners
    FOR EACH ROW EXECUTE FUNCTION sandbox.runners_authorization_lifecycle();

-- ---------------------------------------------------------------------------
-- Runner assignments (owned by the sandbox module): the governed
-- assignment journal. NOT an execution state machine — subordinate
-- bookkeeping on the runner axis; execution identity/lifecycle authority
-- stays in executions.executions.
-- ---------------------------------------------------------------------------

-- Composite-FK enabler (the 0008 compute_environments_scope_key precedent,
-- additive like 0011's sandbox output column): the scope-carrying
-- reference (sandbox_id, application_id) -> sandbox.sandbox_executions
-- needs a unique (id, application_id) index on the parent (id is already
-- the primary key, so uniqueness is trivial — the index exists to carry
-- the composite scope reference).
CREATE UNIQUE INDEX sandbox_executions_scope_key
    ON sandbox.sandbox_executions (id, application_id);

CREATE TABLE sandbox.runner_assignments (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    sandbox_id    uuid NOT NULL,
    environment_id uuid NOT NULL,
    runner_id     uuid NOT NULL,
    assignment_key text NOT NULL,
    request_fingerprint text NOT NULL,
    status        text NOT NULL,
    required_capabilities jsonb NOT NULL,
    lease_leased_at timestamptz NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    lease_duration_ms integer NOT NULL,
    dispatched_at timestamptz,
    handoff_nonce text,
    reported_at   timestamptz,
    outcome_class text,
    failure_class text,
    output_digest text,
    usage_micro_usd text,
    provenance    jsonb NOT NULL,
    reconnect_count integer NOT NULL DEFAULT 0,
    released_reason text,
    released_at   timestamptz,
    expired_at    timestamptz,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT runner_assignments_status_vocabulary CHECK (
        status IN ('assigned', 'dispatched', 'completed', 'failed', 'released', 'expired')
    ),
    CONSTRAINT runner_assignments_outcome_vocabulary CHECK (
        outcome_class IS NULL OR outcome_class IN ('sandbox-success', 'sandbox-failure')
    ),
    CONSTRAINT runner_assignments_failure_vocabulary CHECK (
        failure_class IS NULL OR failure_class IN ('sandbox-execution', 'timeout', 'adapter-error', 'runtime-unavailable')
    ),
    CONSTRAINT runner_assignments_leases_nonempty CHECK (
        length(assignment_key) BETWEEN 1 AND 200
        AND length(request_fingerprint) BETWEEN 1 AND 500
        AND lease_duration_ms BETWEEN 1 AND 86400000
        AND lease_expires_at >= lease_leased_at
    ),
    CONSTRAINT runner_assignments_reconnect_shape CHECK (
        reconnect_count >= 0
        AND (status <> 'assigned' OR reconnect_count = 0)
    ),
    CONSTRAINT runner_assignments_dispatched_shape CHECK (
        status <> 'dispatched' OR (outcome_class IS NULL AND dispatched_at IS NOT NULL AND handoff_nonce IS NOT NULL AND reported_at IS NULL AND released_at IS NULL AND expired_at IS NULL)
    ),
    CONSTRAINT runner_assignments_assigned_shape CHECK (
        status <> 'assigned' OR (outcome_class IS NULL AND dispatched_at IS NULL AND handoff_nonce IS NULL AND reported_at IS NULL AND released_at IS NULL AND expired_at IS NULL)
    ),
    CONSTRAINT runner_assignments_outcome_shape CHECK (
        (status IN ('completed', 'failed')) = (outcome_class IS NOT NULL AND reported_at IS NOT NULL AND dispatched_at IS NOT NULL)
    ),
    CONSTRAINT runner_assignments_completed_shape CHECK (
        status <> 'completed' OR (outcome_class = 'sandbox-success' AND failure_class IS NULL)
    ),
    CONSTRAINT runner_assignments_failed_shape CHECK (
        status <> 'failed' OR (outcome_class = 'sandbox-failure' AND failure_class IS NOT NULL)
    ),
    CONSTRAINT runner_assignments_released_shape CHECK (
        status <> 'released' OR (released_reason IS NOT NULL AND released_at IS NOT NULL AND outcome_class IS NULL AND failure_class IS NULL)
    ),
    CONSTRAINT runner_assignments_expired_shape CHECK (
        status <> 'expired' OR (expired_at IS NOT NULL AND outcome_class IS NULL AND failure_class IS NULL)
    ),
    CONSTRAINT runner_assignments_usage_shape CHECK (
        usage_micro_usd IS NULL OR usage_micro_usd ~ '^\d{1,19}$'
    ),
    CONSTRAINT runner_assignments_metadata_shape CHECK (
        jsonb_typeof(provenance) = 'object'
        AND jsonb_typeof(required_capabilities) = 'array'
    ),
    CONSTRAINT runner_assignments_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT runner_assignments_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT runner_assignments_sandbox_fk
        FOREIGN KEY (sandbox_id, application_id)
        REFERENCES sandbox.sandbox_executions (id, application_id),
    CONSTRAINT runner_assignments_environment_fk
        FOREIGN KEY (environment_id, application_id)
        REFERENCES sandbox.compute_environments (id, application_id),
    CONSTRAINT runner_assignments_runner_fk
        FOREIGN KEY (runner_id, application_id)
        REFERENCES sandbox.runners (id, application_id),
    -- The request idempotency anchor: one durable row per logical assignment.
    CONSTRAINT runner_assignments_request_key UNIQUE (application_id, assignment_key),
    -- Composite FK target for the events trail (scope-carrying reference).
    CONSTRAINT runner_assignments_scope_key UNIQUE (id, application_id)
);

-- THE split-brain guard (M19): at most one ACTIVE assignment per runner in
-- any committed snapshot. The release/assignment race converges through
-- the partial unique index (the insert either lands after the release
-- commits or fails closed).
CREATE UNIQUE INDEX runner_assignments_active_slot
    ON sandbox.runner_assignments (runner_id)
    WHERE status IN ('assigned', 'dispatched');

CREATE INDEX runner_assignments_by_execution
    ON sandbox.runner_assignments (application_id, execution_id, created_at);
CREATE INDEX runner_assignments_by_sandbox
    ON sandbox.runner_assignments (application_id, sandbox_id, created_at);
CREATE INDEX runner_assignments_by_runner
    ON sandbox.runner_assignments (application_id, runner_id, status);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION sandbox.runner_assignments_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.runner_assignments rows are never deleted (assignment %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_assignments_no_delete
    BEFORE DELETE ON sandbox.runner_assignments
    FOR EACH ROW EXECUTE FUNCTION sandbox.runner_assignments_no_delete();

-- The identity core is immutable on EVERY update path (the assigned work
-- is always the admitted work; the runner choice is durable identity).
CREATE OR REPLACE FUNCTION sandbox.runner_assignments_immutable_identity() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.sandbox_id <> OLD.sandbox_id OR NEW.environment_id <> OLD.environment_id OR NEW.runner_id <> OLD.runner_id OR NEW.assignment_key <> OLD.assignment_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities OR NEW.lease_leased_at <> OLD.lease_leased_at OR NEW.lease_expires_at <> OLD.lease_expires_at OR NEW.lease_duration_ms <> OLD.lease_duration_ms OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.created_at <> OLD.created_at OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at) OR (OLD.handoff_nonce IS NOT NULL AND NEW.handoff_nonce IS DISTINCT FROM OLD.handoff_nonce) OR NEW.reconnect_count < OLD.reconnect_count THEN RAISE EXCEPTION 'sandbox.runner_assignments identity, lease and dispatch intent are immutable (assignment %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_assignments_immutable_identity_guard
    BEFORE UPDATE ON sandbox.runner_assignments
    FOR EACH ROW EXECUTE FUNCTION sandbox.runner_assignments_immutable_identity();

-- Terminal rows are physically immutable; the only legal UPDATE paths are
-- the one-shot transitions and reconnect bookkeeping on dispatched rows.
CREATE OR REPLACE FUNCTION sandbox.runner_assignments_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed', 'failed', 'released', 'expired') THEN RAISE EXCEPTION 'sandbox.runner_assignments is terminal-immutable in state % (assignment %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'assigned' AND NEW.status IN ('assigned', 'dispatched', 'released', 'expired')) OR (OLD.status = 'dispatched' AND NEW.status IN ('dispatched', 'completed', 'failed', 'released', 'expired'))) THEN RAISE EXCEPTION 'runner assignment % cannot move from status % to % (assigned claims dispatch; dispatched finalizes to completed/failed/released/expired)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_assignments_lifecycle_guard
    BEFORE UPDATE ON sandbox.runner_assignments
    FOR EACH ROW EXECUTE FUNCTION sandbox.runner_assignments_lifecycle();

-- ---------------------------------------------------------------------------
-- Runner assignment events (owned by the sandbox module): the append-only
-- evidence trail — assignment, dispatch, reconnect, report and terminal
-- events carry the full provenance (actor, cause, detail) with a
-- per-assignment monotonic sequence. No UPDATE, no DELETE, ever.
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.runner_assignment_events (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    runner_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    sequence      integer NOT NULL,
    event         text NOT NULL,
    actor_id      text NOT NULL,
    cause         text NOT NULL,
    detail        jsonb NOT NULL,
    occurred_at   timestamptz NOT NULL,
    CONSTRAINT runner_assignment_events_vocabulary CHECK (
        event IN ('assigned', 'dispatched', 'reconnected', 'reported', 'completed', 'failed', 'released', 'expired', 'revoked')
    ),
    CONSTRAINT runner_assignment_events_sequence_shape CHECK (sequence >= 1),
    CONSTRAINT runner_assignment_events_cause_shape CHECK (cause ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT runner_assignment_events_detail_shape CHECK (jsonb_typeof(detail) = 'object'),
    CONSTRAINT runner_assignment_events_sequence_key UNIQUE (assignment_id, sequence),
    CONSTRAINT runner_assignment_events_assignment_fk
        FOREIGN KEY (assignment_id, application_id)
        REFERENCES sandbox.runner_assignments (id, application_id)
);

CREATE INDEX runner_assignment_events_trail
    ON sandbox.runner_assignment_events (application_id, assignment_id, sequence);

-- Events are strictly append-only.
CREATE OR REPLACE FUNCTION sandbox.runner_assignment_events_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.runner_assignment_events is append-only (event %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_assignment_events_no_update
    BEFORE UPDATE ON sandbox.runner_assignment_events
    FOR EACH ROW EXECUTE FUNCTION sandbox.runner_assignment_events_immutable();

CREATE TRIGGER runner_assignment_events_no_delete
    BEFORE DELETE ON sandbox.runner_assignment_events
    FOR EACH ROW EXECUTE FUNCTION sandbox.runner_assignment_events_immutable();
