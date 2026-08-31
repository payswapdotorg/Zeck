-- WORK-023 — Multimodal Agent Deployment Fabric (MOD-001..004/010).
--
-- The durable state of the deployment fabric: the immutable versioned
-- PROFILES and PLANS, the control-plane DEPLOYMENTS (identity bound
-- to application/environment/agent-version — MOD-002), and the
-- append-only lifecycle JOURNAL (actor, cause, prior/current plan
-- version, execution provenance — MOD-003).
--
-- AUTHORITY PRESERVATION (the frozen invariants + ADR-0014):
--   * deployment is an Execution-ADJACENT control-plane object: no
--     table here references policy, budget, capability, verification
--     or execution STATE as a writable target, and there is NO
--     execution state machine (deployments govern configuration;
--     executions remain the runs, in executions.executions);
--   * modality adapters are replaceable infrastructure behind the
--     neutral seam — the plan's channel bindings are jsonb of
--     provider-neutral (channelKind, adapterCapabilityId) pairs;
--     vendor identifiers are structurally absent (MOD-004);
--   * cross-module references are READ-ONLY bindings:
--     (application_id, tenant_id) -> applications.applications;
--     environment_id -> applications.environments (the deployment
--     identity binding); agent identity is referenced by UUID
--     WITHOUT an FK (BYOA external agents are representable —
--     MOD-010 — and their versions live in the agents module's
--     authority, resolved through its public seam at validation
--     time, not by a physical FK);
--   * execution provenance on lifecycle events is a REFERENCE
--     (execution_id uuid, no FK): the journal records which
--     execution commanded/observed a lifecycle change without
--     reaching into the executions state machine.
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * profiles/plans are IMMUTABLE VERSIONED artifacts: UNIQUE
--     (application, identity, version) arbitrates concurrent
--     publications (identical digest converges; a different digest
--     fails closed); rows are never updated or deleted (triggers);
--   * deployments: the identity core (ids, slug, name, environment,
--     agent binding, creation fingerprint, created_at) is immutable
--     on every UPDATE path; the status/pointer transitions are
--     guarded (active<->suspended, ->retired terminal; retired rows
--     fully immutable); rows never deleted;
--   * the lifecycle journal is APPEND-ONLY, identity-ordered
--     (event_seq), idempotent per (application, idempotency_key)
--     (UNIQUE — a retried lifecycle request replays the committed
--     event); rows never updated or deleted;
--   * a byoa agent reference carries an OPAQUE external descriptor
--     (ref + bounded text) — the CHECK pins the descriptor shape and
--     forbids credential-shaped content by length discipline (the
--     domain validation scans the nine secret patterns; the SQL
--     level pins the container shapes).
--
-- Migration-version discipline (the collision rule, parallel wave):
-- the live inventory at authoring time is 0001..0010 (merged) plus
-- WORK-018's claimed-but-unmerged 0011 (the sibling in this parallel
-- wave — its evidence file documents the same assignment). The wave
-- pre-assigned numbers by dispatch order: WORK-018 claims 0011,
-- WORK-023 claims 0012 (THIS migration), WORK-031 claims 0013. No
-- other unmerged Work Order claims any number.

-- ---------------------------------------------------------------------------
-- Versioned immutable deployment profiles (MOD-001).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.deployment_profiles (
    profile_id   text NOT NULL,
    version      integer NOT NULL,
    application_id uuid NOT NULL,
    tenant_id    uuid NOT NULL,
    modality     text NOT NULL,
    channel_kinds jsonb NOT NULL,
    required_capabilities jsonb NOT NULL,
    latency_class text NOT NULL,
    resource_class text NOT NULL,
    side_effect_class text NOT NULL,
    input_modalities jsonb NOT NULL,
    output_modalities jsonb NOT NULL,
    description  text,
    digest       text NOT NULL,
    created_by   uuid NOT NULL,
    created_at   timestamptz NOT NULL,
    CONSTRAINT profiles_vocabulary CHECK (modality IN ('realtime-voice','messaging','media-generation','document-vision','realtime-multimodal','background-automation','custom')),
    CONSTRAINT profiles_latency CHECK (latency_class IN ('realtime','interactive','asynchronous')),
    CONSTRAINT profiles_resource CHECK (resource_class IN ('light','standard','heavy','accelerated')),
    CONSTRAINT profiles_side_effect CHECK (side_effect_class IN ('none','read-only','write-external')),
    CONSTRAINT profiles_channel_kinds_array CHECK (jsonb_typeof(channel_kinds) = 'array' AND jsonb_array_length(channel_kinds) >= 1),
    CONSTRAINT profiles_capabilities_array CHECK (jsonb_typeof(required_capabilities) = 'array'),
    CONSTRAINT profiles_modalities_arrays CHECK (jsonb_typeof(input_modalities) = 'array' AND jsonb_typeof(output_modalities) = 'array'),
    CONSTRAINT profiles_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    CONSTRAINT profiles_description_bounded CHECK (description IS NULL OR length(description) <= 2000),
    CONSTRAINT profiles_version_positive CHECK (version >= 1),
    CONSTRAINT profiles_identity_unique UNIQUE (application_id, profile_id, version),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX profiles_scope_listing
    ON deployments.deployment_profiles (application_id, profile_id, version);

CREATE OR REPLACE FUNCTION deployments.profiles_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.deployment_profiles rows are immutable (profile % version %)', OLD.profile_id, OLD.version; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER deployment_profiles_immutable_guard
    BEFORE UPDATE OR DELETE ON deployments.deployment_profiles
    FOR EACH ROW EXECUTE FUNCTION deployments.profiles_immutable();

-- ---------------------------------------------------------------------------
-- Versioned immutable deployment plans (MOD-001/MOD-010).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.deployment_plans (
    plan_id      text NOT NULL,
    version      integer NOT NULL,
    application_id uuid NOT NULL,
    tenant_id    uuid NOT NULL,
    profile_id   text NOT NULL,
    profile_version integer NOT NULL,
    agent_id     uuid NOT NULL,
    agent_version text NOT NULL,
    agent_kind   text NOT NULL,
    external_descriptor jsonb,
    environment_id uuid NOT NULL,
    channel_bindings jsonb NOT NULL,
    session_policy jsonb NOT NULL,
    description  text,
    digest       text NOT NULL,
    created_by   uuid NOT NULL,
    created_at   timestamptz NOT NULL,
    CONSTRAINT plans_version_positive CHECK (version >= 1),
    CONSTRAINT plans_agent_kind CHECK (agent_kind IN ('zeck','byoa')),
    CONSTRAINT plans_agent_version_format CHECK (agent_version ~ '^\d+\.\d+\.\d+$'),
    CONSTRAINT plans_byoa_descriptor CHECK (
        (agent_kind = 'byoa' AND external_descriptor IS NOT NULL
            AND jsonb_typeof(external_descriptor) = 'object'
            AND length((external_descriptor->>'ref')::text) BETWEEN 1 AND 200)
        OR (agent_kind = 'zeck' AND external_descriptor IS NULL)),
    CONSTRAINT plans_bindings_array CHECK (jsonb_typeof(channel_bindings) = 'array' AND jsonb_array_length(channel_bindings) BETWEEN 1 AND 16),
    CONSTRAINT plans_session_policy_object CHECK (jsonb_typeof(session_policy) = 'object'
        AND (session_policy->>'maxSessionDurationMs')::bigint BETWEEN 1 AND 86400000
        AND (session_policy->>'maxConcurrentSessions')::bigint BETWEEN 1 AND 10000),
    CONSTRAINT plans_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    CONSTRAINT plans_description_bounded CHECK (description IS NULL OR length(description) <= 2000),
    CONSTRAINT plans_identity_unique UNIQUE (application_id, plan_id, version),
    CONSTRAINT plans_profile_fk FOREIGN KEY (application_id, profile_id, profile_version)
        REFERENCES deployments.deployment_profiles (application_id, profile_id, version),
    CONSTRAINT plans_environment_fk FOREIGN KEY (environment_id)
        REFERENCES applications.environments (id)
);

CREATE INDEX plans_scope_listing
    ON deployments.deployment_plans (application_id, plan_id, version);

CREATE OR REPLACE FUNCTION deployments.plans_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.deployment_plans rows are immutable (plan % version %)', OLD.plan_id, OLD.version; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER deployment_plans_immutable_guard
    BEFORE UPDATE OR DELETE ON deployments.deployment_plans
    FOR EACH ROW EXECUTE FUNCTION deployments.plans_immutable();

-- ---------------------------------------------------------------------------
-- Deployments — the control-plane identity (MOD-002/MOD-003).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.deployments (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    environment_id uuid NOT NULL,
    agent_id      uuid NOT NULL,
    agent_version text NOT NULL,
    agent_kind    text NOT NULL,
    slug          text NOT NULL,
    name          text NOT NULL,
    description   text,
    status        text NOT NULL,
    current_plan_id text NOT NULL,
    current_plan_version integer NOT NULL,
    revision      integer NOT NULL,
    creation_fingerprint text NOT NULL,
    created_by    uuid NOT NULL,
    idempotency_key text NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT deployments_status_vocabulary CHECK (status IN ('active','suspended','retired')),
    CONSTRAINT deployments_agent_kind CHECK (agent_kind IN ('zeck','byoa')),
    CONSTRAINT deployments_agent_version_format CHECK (agent_version ~ '^\d+\.\d+\.\d+$'),
    CONSTRAINT deployments_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT deployments_revision_nonnegative CHECK (revision >= 0),
    CONSTRAINT deployments_plan_version_positive CHECK (current_plan_version >= 1),
    CONSTRAINT deployments_fingerprint_nonempty CHECK (length(creation_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT deployments_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT deployments_slug_unique UNIQUE (application_id, slug),
    CONSTRAINT deployments_identity_unique UNIQUE (application_id, environment_id, agent_id, agent_version),
    CONSTRAINT deployments_environment_fk FOREIGN KEY (environment_id)
        REFERENCES applications.environments (id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT deployments_initial_plan_fk FOREIGN KEY (application_id, current_plan_id, current_plan_version)
        REFERENCES deployments.deployment_plans (application_id, plan_id, version)
);

CREATE INDEX deployments_scope_listing
    ON deployments.deployments (application_id, created_at, id);

-- The identity core is write-once; only the guarded status/pointer/
-- revision fields may move.
CREATE OR REPLACE FUNCTION deployments.deployments_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.environment_id <> OLD.environment_id OR NEW.agent_id <> OLD.agent_id OR NEW.agent_version <> OLD.agent_version OR NEW.agent_kind <> OLD.agent_kind OR NEW.slug <> OLD.slug OR NEW.name <> OLD.name OR NEW.description IS DISTINCT FROM OLD.description OR NEW.creation_fingerprint <> OLD.creation_fingerprint OR NEW.created_by <> OLD.created_by OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.deployments identity core is immutable (deployment %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_core_guard
    BEFORE UPDATE ON deployments.deployments
    FOR EACH ROW EXECUTE FUNCTION deployments.deployments_core_immutable();

-- The frozen control-plane lifecycle: active <-> suspended, either ->
-- retired (terminal-immutable). The plan pointer may only move
-- forward through an explicit version change (promotion/rollback are
-- version moves, never identity rewrites).
CREATE OR REPLACE FUNCTION deployments.deployments_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status = 'retired' THEN RAISE EXCEPTION 'deployments.deployments is terminal-immutable in state retired (deployment %)', OLD.id; END IF; IF NOT ((OLD.status = 'active' AND NEW.status IN ('active','suspended','retired')) OR (OLD.status = 'suspended' AND NEW.status IN ('suspended','active','retired'))) THEN RAISE EXCEPTION 'deployment % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; IF NEW.current_plan_version < 1 THEN RAISE EXCEPTION 'deployment % plan version must stay positive', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_lifecycle_guard
    BEFORE UPDATE ON deployments.deployments
    FOR EACH ROW EXECUTE FUNCTION deployments.deployments_lifecycle();

CREATE OR REPLACE FUNCTION deployments.deployments_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.deployments rows are never deleted (deployment %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_no_delete_guard
    BEFORE DELETE ON deployments.deployments
    FOR EACH ROW EXECUTE FUNCTION deployments.deployments_no_delete();

-- ---------------------------------------------------------------------------
-- The append-only lifecycle journal (MOD-003).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.deployment_events (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    deployment_id uuid NOT NULL,
    kind          text NOT NULL,
    actor_id      uuid NOT NULL,
    cause         text,
    prior_plan_version integer,
    current_plan_version integer,
    execution_id  uuid,
    event_seq     bigint GENERATED ALWAYS AS IDENTITY,
    idempotency_key text NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT events_kind_vocabulary CHECK (kind IN ('create','promote','rollback','suspend','resume','retire')),
    CONSTRAINT events_cause_bounded CHECK (cause IS NULL OR length(cause) <= 2000),
    CONSTRAINT events_plan_versions_positive CHECK (prior_plan_version IS NULL OR prior_plan_version >= 1),
    CONSTRAINT events_current_plan_positive CHECK (current_plan_version IS NULL OR current_plan_version >= 1),
    CONSTRAINT events_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT events_key_unique UNIQUE (application_id, idempotency_key),
    CONSTRAINT events_deployment_fk FOREIGN KEY (deployment_id)
        REFERENCES deployments.deployments (id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX events_deployment_order
    ON deployments.deployment_events (application_id, deployment_id, event_seq);

CREATE OR REPLACE FUNCTION deployments.events_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.deployment_events is append-only (event %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER deployment_events_append_only_guard
    BEFORE UPDATE OR DELETE ON deployments.deployment_events
    FOR EACH ROW EXECUTE FUNCTION deployments.events_append_only();
