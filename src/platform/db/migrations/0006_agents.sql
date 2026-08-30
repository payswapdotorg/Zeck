-- WORK-011 — Agent fabric, sessions and workspaces.
--
-- Durable agent identity/inventory (AGT-003/ACP-001), immutable versioned
-- artifacts with validation state and promotion/rollback selections
-- (AGT-004/ACP-002), governed sessions bound to execution identity with
-- workspaces and scoped revocable credential grants (AGT-002/AGT-005/
-- ACP-003), and human approval requests with full decision provenance
-- (AGT-006/ACP-004). Session evidence rides the executions EventEnvelope
-- ledger as step events (AGT-008/ACP-006) — these tables carry the
-- agent-axis durable state; they are NOT a second execution ledger.
--
-- Physical invariants enforced here (the WORK-004/0004/0005 discipline of
-- making violations UNREPRESENTABLE, not merely discouraged):
--
--   * agent identity is UNIQUE (application_id, slug): duplicate
--     registrations converge through the unique-index arbitration —
--     conflicting identities are impossible (M17);
--   * agent VERSIONS are WRITE-ONCE: rows are inserted with their
--     validation state and are NEVER updated or deleted (physical
--     triggers; M15) — promotion/rollback append agent_selections rows
--     and never touch the artifact (M16);
--   * selections are append-only with UNIQUE (application_id,
--     selection_key) idempotency arbitration;
--   * sessions are UNIQUE (application_id, session_key): concurrent
--     duplicate session creation converges on ONE durable identity
--     (M18); terminal sessions are physically immutable;
--   * workspaces/grants/approvals bind to their session by composite
--     (session_id, application_id) FKs — cross-scope rows are
--     unrepresentable; grants are CHECK-bound to scope KIND + opaque
--     reference (no value column exists at all — raw secrets are
--     unrepresentable at the storage boundary, M6/M7);
--   * approvals are CHECK-bound to the approval vocabulary; terminal
--     approvals (approved/denied/revoked/expired) are immutable;
--   * the autonomy vocabulary is the policies module's frozen ladder
--     (CHECK-bound, not a free-text column).
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE SCHEMA agents;

-- ---------------------------------------------------------------------------
-- Agent identity + inventory catalog (owned by the agents module).
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agents (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    slug          text NOT NULL,
    name          text NOT NULL,
    description   text,
    status        text NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT agents_status_vocabulary CHECK (status IN ('registered', 'validated', 'available', 'suspended', 'retired')),
    CONSTRAINT agents_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
    CONSTRAINT agents_identity_key UNIQUE (application_id, slug),
    -- composite FK target for versions/sessions (scope-carrying references)
    CONSTRAINT agents_scope_key UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX agents_catalog_by_tenant
    ON agents.agents (application_id, tenant_id, status);

-- ---------------------------------------------------------------------------
-- Agent versions: immutable executable artifacts (write-once rows).
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agent_versions (
    id                uuid PRIMARY KEY,
    application_id    uuid NOT NULL,
    tenant_id         uuid NOT NULL,
    agent_id          uuid NOT NULL,
    version           text NOT NULL,
    definition        jsonb NOT NULL,
    definition_digest text NOT NULL,
    validation_state  text NOT NULL,
    validation_notes  text,
    created_at        timestamptz NOT NULL,
    CONSTRAINT agent_versions_validation_vocabulary
        CHECK (validation_state IN ('pending', 'valid', 'invalid')),
    CONSTRAINT agent_versions_semver_shape CHECK (version ~ '^\d+\.\d+\.\d+$'),
    CONSTRAINT agent_versions_identity_key UNIQUE (application_id, agent_id, version),
    -- composite FK target for selections/sessions
    CONSTRAINT agent_versions_scope_key UNIQUE (id, application_id),
    FOREIGN KEY (agent_id, application_id)
        REFERENCES agents.agents (id, application_id)
);

CREATE INDEX agent_versions_by_agent
    ON agents.agent_versions (application_id, agent_id, created_at);

-- Versions are immutable artifacts: no UPDATE, no DELETE — ever.
CREATE OR REPLACE FUNCTION agents.agent_versions_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agents.agent_versions rows are immutable artifacts (version %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_versions_immutable_guard
    BEFORE UPDATE OR DELETE ON agents.agent_versions
    FOR EACH ROW EXECUTE FUNCTION agents.agent_versions_immutable();

-- ---------------------------------------------------------------------------
-- Agent selections: the append-only promotion/rollback journal. The
-- current version of an agent is the LATEST selection; rollback appends a
-- new record selecting a previously valid version — artifacts never mutate.
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agent_selections (
    id                  uuid PRIMARY KEY,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    agent_id            uuid NOT NULL,
    selected_version_id uuid NOT NULL,
    kind                text NOT NULL,
    rollback_of         uuid,
    selected_by         text NOT NULL,
    reason              text,
    selected_at         timestamptz NOT NULL,
    selection_key       text NOT NULL,
    CONSTRAINT agent_selections_kind_vocabulary CHECK (kind IN ('initial', 'promotion', 'rollback')),
    CONSTRAINT agent_selections_key UNIQUE (application_id, selection_key),
    FOREIGN KEY (agent_id, application_id)
        REFERENCES agents.agents (id, application_id),
    FOREIGN KEY (selected_version_id, application_id)
        REFERENCES agents.agent_versions (id, application_id)
);

CREATE INDEX agent_selections_latest
    ON agents.agent_selections (application_id, agent_id, selected_at DESC);

-- Selections are never deleted or rewritten.
CREATE OR REPLACE FUNCTION agents.agent_selections_no_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agents.agent_selections is an append-only journal (selection %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_selections_no_update_or_delete
    BEFORE UPDATE OR DELETE ON agents.agent_selections
    FOR EACH ROW EXECUTE FUNCTION agents.agent_selections_no_mutation();

-- ---------------------------------------------------------------------------
-- Agent sessions: governed session identity bound to the parent execution.
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agent_sessions (
    id                     uuid PRIMARY KEY,
    application_id         uuid NOT NULL,
    tenant_id              uuid NOT NULL,
    execution_id           uuid NOT NULL,
    agent_id               uuid NOT NULL,
    agent_version_id       uuid NOT NULL,
    workspace_id           uuid NOT NULL,
    session_key            text NOT NULL,
    request_fingerprint    text NOT NULL,
    status                 text NOT NULL,
    input_digest           text NOT NULL,
    input_artifact_refs    jsonb NOT NULL DEFAULT '[]'::jsonb,
    effective_permissions  jsonb NOT NULL,
    policy_evidence        jsonb NOT NULL,
    autonomy               text NOT NULL,
    output_digest          text,
    output                 jsonb,
    failure_reason         text,
    created_at             timestamptz NOT NULL,
    started_at             timestamptz,
    completed_at           timestamptz,
    ledger_start_sequence  bigint,
    ledger_end_sequence    bigint,
    CONSTRAINT agent_sessions_status_vocabulary
        CHECK (status IN ('pending', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled')),
    CONSTRAINT agent_sessions_autonomy_vocabulary
        CHECK (autonomy IN ('none', 'gated', 'sandboxed', 'unconstrained')),
    CONSTRAINT agent_sessions_request_key UNIQUE (application_id, session_key),
    -- composite FK target for workspaces/grants/approvals
    CONSTRAINT agent_sessions_scope_key UNIQUE (id, application_id),
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    FOREIGN KEY (agent_version_id, application_id)
        REFERENCES agents.agent_versions (id, application_id)
);

CREATE INDEX agent_sessions_by_execution
    ON agents.agent_sessions (application_id, execution_id, created_at);

CREATE INDEX agent_sessions_by_agent
    ON agents.agent_sessions (application_id, agent_id, created_at);

-- Sessions are never deleted.
CREATE OR REPLACE FUNCTION agents.agent_sessions_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agents.agent_sessions rows are never deleted (session %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_sessions_no_delete_guard
    BEFORE DELETE ON agents.agent_sessions
    FOR EACH ROW EXECUTE FUNCTION agents.agent_sessions_no_delete();

-- Terminal sessions are physically immutable; live sessions may only move
-- within the explicit session lifecycle vocabulary.
CREATE OR REPLACE FUNCTION agents.agent_sessions_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed', 'failed', 'cancelled') THEN RAISE EXCEPTION 'agents.agent_sessions is terminal-immutable in state % (session %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled') THEN RAISE EXCEPTION 'agent session % cannot move to unknown status %', OLD.id, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_sessions_lifecycle_guard
    BEFORE UPDATE ON agents.agent_sessions
    FOR EACH ROW EXECUTE FUNCTION agents.agent_sessions_lifecycle();

-- ---------------------------------------------------------------------------
-- Agent workspaces: execution-environment/context boundaries bound to
-- their session (and through it to the parent execution). Tenant and
-- application scope are carried by the composite FKs — cross-scope
-- workspaces are unrepresentable.
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agent_workspaces (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    execution_id   uuid NOT NULL,
    session_id     uuid NOT NULL,
    created_at     timestamptz NOT NULL,
    CONSTRAINT agent_workspaces_session_key UNIQUE (application_id, session_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    FOREIGN KEY (session_id, application_id)
        REFERENCES agents.agent_sessions (id, application_id)
);

CREATE OR REPLACE FUNCTION agents.agent_workspaces_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agents.agent_workspaces rows are immutable (workspace %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_workspaces_immutable_guard
    BEFORE UPDATE OR DELETE ON agents.agent_workspaces
    FOR EACH ROW EXECUTE FUNCTION agents.agent_workspaces_immutable();

-- ---------------------------------------------------------------------------
-- Agent credential grants: scoped, revocable, auditable, runtime-specific
-- capabilities. There is deliberately NO value/material column — grants
-- carry a scope KIND and an opaque REFERENCE only (AGT-005/ACP-003: raw
-- long-lived secrets are unrepresentable in agent state).
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agent_credential_grants (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    session_id     uuid NOT NULL,
    scope_kind     text NOT NULL,
    scope_ref      text NOT NULL,
    status         text NOT NULL,
    issued_at      timestamptz NOT NULL,
    expires_at     timestamptz,
    revoked_at     timestamptz,
    CONSTRAINT agent_grants_scope_vocabulary CHECK (scope_kind IN ('model', 'tool', 'endpoint', 'secret')),
    CONSTRAINT agent_grants_status_vocabulary CHECK (status IN ('active', 'revoked', 'expired')),
    CONSTRAINT agent_grants_ref_shape CHECK (scope_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$'),
    CONSTRAINT agent_grants_scope_unique UNIQUE (session_id, scope_kind, scope_ref),
    FOREIGN KEY (session_id, application_id)
        REFERENCES agents.agent_sessions (id, application_id)
);

CREATE INDEX agent_grants_by_session
    ON agents.agent_credential_grants (application_id, session_id, status);

-- Grants are never deleted; revocation is monotonic (never back to active).
CREATE OR REPLACE FUNCTION agents.agent_grants_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agents.agent_credential_grants rows are never deleted (grant %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_grants_no_delete_guard
    BEFORE DELETE ON agents.agent_credential_grants
    FOR EACH ROW EXECUTE FUNCTION agents.agent_grants_no_delete();

CREATE OR REPLACE FUNCTION agents.agent_grants_revocation_monotonic() RETURNS trigger AS $$ BEGIN IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN RAISE EXCEPTION 'agent grant % revocation is monotonic (cannot return to %)', OLD.id, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_grants_revocation_guard
    BEFORE UPDATE ON agents.agent_credential_grants
    FOR EACH ROW EXECUTE FUNCTION agents.agent_grants_revocation_monotonic();

-- ---------------------------------------------------------------------------
-- Agent approval requests: policy-designated human gates with full
-- decision provenance (approver, execution, requested action, policy
-- basis, timestamps, decision).
-- ---------------------------------------------------------------------------

CREATE TABLE agents.agent_approval_requests (
    id                   uuid PRIMARY KEY,
    application_id       uuid NOT NULL,
    tenant_id            uuid NOT NULL,
    execution_id         uuid NOT NULL,
    session_id           uuid NOT NULL,
    action_class         text NOT NULL,
    action_descriptor    jsonb NOT NULL,
    policy_basis         text NOT NULL,
    status               text NOT NULL,
    approval_key         text NOT NULL,
    requested_at         timestamptz NOT NULL,
    decided_at           timestamptz,
    approver_id          text,
    decision             text,
    expires_at           timestamptz,
    ledger_wait_sequence bigint,
    CONSTRAINT agent_approvals_status_vocabulary
        CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'expired')),
    CONSTRAINT agent_approvals_decision_vocabulary
        CHECK (decision IS NULL OR decision IN ('approved', 'denied')),
    CONSTRAINT agent_approvals_action_shape CHECK (action_class ~ '^[a-z0-9][a-z0-9:-]{0,99}$'),
    CONSTRAINT agent_approvals_request_key UNIQUE (application_id, approval_key),
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    FOREIGN KEY (session_id, application_id)
        REFERENCES agents.agent_sessions (id, application_id)
);

CREATE INDEX agent_approvals_by_session
    ON agents.agent_approval_requests (application_id, session_id, requested_at);

-- Approvals are never deleted.
CREATE OR REPLACE FUNCTION agents.agent_approvals_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'agents.agent_approval_requests rows are never deleted (approval %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_approvals_no_delete_guard
    BEFORE DELETE ON agents.agent_approval_requests
    FOR EACH ROW EXECUTE FUNCTION agents.agent_approvals_no_delete();

-- Terminal approvals are immutable; decisions land exactly once and only
-- on pending rows (an agent cannot fabricate or rewrite a decision).
CREATE OR REPLACE FUNCTION agents.agent_approvals_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('approved', 'denied', 'revoked', 'expired') THEN RAISE EXCEPTION 'agents.agent_approval_requests is terminal-immutable in state % (approval %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending', 'approved', 'denied', 'revoked', 'expired') THEN RAISE EXCEPTION 'agent approval % cannot move to unknown status %', OLD.id, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_approvals_lifecycle_guard
    BEFORE UPDATE ON agents.agent_approval_requests
    FOR EACH ROW EXECUTE FUNCTION agents.agent_approvals_lifecycle();
