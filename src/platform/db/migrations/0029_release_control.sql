-- WORK-047 — Production delivery, observability and release control (D-06).
--
-- The durable PostgreSQL release-control ledger
-- (`docs/DEPLOYMENT-ARCHITECTURE.md` delivery, `spec/work-orders/WORK-047.md`).
--
-- WHAT THIS SCHEMA IS:
--
--   * THE RELEASE LEDGER. Every release maps to ONE exact Git commit
--     (40-hex, CHECK-bound) and one manifest digest — the immutable,
--     content-addressed release attribution. CI/CD, provider control
--     planes and dashboards are MECHANISMS that drive this ledger
--     through the governed store; they never own it.
--
--   * EVIDENCE IS APPEND-ONLY. Gate results (validation, typecheck,
--     lint, tests, ci, migration, health, smoke, approval, identity
--     audit) are recorded as IMMUTABLE attempts — the latest attempt
--     per gate kind is the effective result. Promotion decisions
--     (including REFUSALS — refusals are evidence too) and rollback
--     events are append-only journals.
--
--   * ONE ACTIVE DEPLOYMENT POINTER PER HOSTING ENVIRONMENT. The
--     pointer moves ONLY through the governed store transaction
--     (activation requires the phase's gate evidence AND a recorded
--     `promoted` journal decision; rollback requires a
--     previously-passing target and appends the rollback event).
--     Rows are never deleted.
--
--   * ROLLBACK IS DEPLOYMENT STATE ONLY. The store's statements
--     address release_control exclusively: a rollback flips the
--     pointer and journals the event — durable execution/business
--     state is untouched by construction (pinned by the isolation
--     tests).
--
--   * BOUNDED BY PHYSICAL CHECKS: environment/gate/decision
--     vocabularies, attempt ordinal, actor length, evidence-detail
--     length, digest shapes.
--
-- Migration-version discipline (the collision rule): the live
-- inventory at authoring time is 0001..0014, 0016..0028 (0015 is
-- BURNED). **WORK-047 claims 0029 — THIS migration. No other unmerged
-- Work Order claims 0029.**
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — every trigger function body below is a
-- single line with no embedded `;` line endings.

CREATE SCHEMA release_control;

-- ---------------------------------------------------------------------------
-- Releases: the immutable, content-addressed release attribution.
-- ---------------------------------------------------------------------------

CREATE TABLE release_control.releases (
    release_id      text PRIMARY KEY,
    git_revision    text NOT NULL,
    manifest_digest text NOT NULL,
    recorded_at     timestamptz NOT NULL,
    recorded_by     text NOT NULL,
    CHECK (release_id ~ '^[0-9a-f]{64}$'),
    CHECK (git_revision ~ '^[0-9a-f]{40}$'),
    CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
    CHECK (length(recorded_by) <= 128),
    UNIQUE (git_revision, manifest_digest)
);

CREATE FUNCTION release_control.reject_release_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release_control.releases is immutable: release attribution (id, exact commit, manifest digest, recorder, time) is append-only'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER releases_immutable
    BEFORE UPDATE OR DELETE ON release_control.releases
    FOR EACH ROW EXECUTE FUNCTION release_control.reject_release_mutation();

-- ---------------------------------------------------------------------------
-- Environment deployments: the per-environment identity binding
-- (the D-01 deployment identity document of one release at one
-- hosting environment; immutable once bound).
-- ---------------------------------------------------------------------------

CREATE TABLE release_control.environment_deployments (
    release_id             text NOT NULL REFERENCES release_control.releases (release_id),
    environment            text NOT NULL,
    deployment_identity_id text NOT NULL,
    resource_digest        text NOT NULL,
    recorded_at            timestamptz NOT NULL,
    recorded_by            text NOT NULL,
    PRIMARY KEY (release_id, environment),
    CHECK (environment IN ('local', 'preview', 'staging', 'production')),
    CHECK (deployment_identity_id ~ '^[0-9a-f]{64}$'),
    CHECK (resource_digest ~ '^[0-9a-f]{64}$'),
    CHECK (length(recorded_by) <= 128)
);

CREATE FUNCTION release_control.reject_environment_deployment_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release_control.environment_deployments is immutable: the deployment identity binding is append-only'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER environment_deployments_immutable
    BEFORE UPDATE OR DELETE ON release_control.environment_deployments
    FOR EACH ROW EXECUTE FUNCTION release_control.reject_environment_deployment_mutation();

-- ---------------------------------------------------------------------------
-- Gate results: the append-only promotion evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE release_control.gate_results (
    release_id     text NOT NULL REFERENCES release_control.releases (release_id),
    environment    text NOT NULL,
    gate_kind      text NOT NULL,
    attempt        integer NOT NULL,
    status         text NOT NULL,
    evidence_digest text NOT NULL,
    evidence_detail text NOT NULL,
    source         text NOT NULL,
    recorded_at    timestamptz NOT NULL,
    recorded_by    text NOT NULL,
    PRIMARY KEY (release_id, environment, gate_kind, attempt),
    CHECK (environment IN ('local', 'ci', 'preview', 'staging', 'production')),
    CHECK (status IN ('passed', 'failed')),
    CHECK (source IN ('tool-run', 'external-attach')),
    CHECK (attempt >= 1),
    CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    CHECK (length(evidence_detail) <= 4096),
    CHECK (length(gate_kind) <= 64),
    CHECK (length(recorded_by) <= 128)
);

CREATE FUNCTION release_control.reject_gate_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release_control.gate_results is append-only: gate evidence attempts are immutable (record a new attempt; never rewrite history)'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER gate_results_append_only
    BEFORE UPDATE OR DELETE ON release_control.gate_results
    FOR EACH ROW EXECUTE FUNCTION release_control.reject_gate_mutation();

-- ---------------------------------------------------------------------------
-- Promotions: the append-only decision journal (refusals included).
-- ---------------------------------------------------------------------------

CREATE TABLE release_control.promotions (
    id          text PRIMARY KEY,
    release_id  text NOT NULL REFERENCES release_control.releases (release_id),
    from_phase  text NOT NULL,
    to_phase    text NOT NULL,
    decision    text NOT NULL,
    reason      text NOT NULL,
    actor       text NOT NULL,
    decided_at  timestamptz NOT NULL,
    CHECK (from_phase IN ('none', 'local', 'ci', 'preview', 'staging', 'production')),
    CHECK (to_phase IN ('local', 'ci', 'preview', 'staging', 'production')),
    CHECK (decision IN ('promoted', 'refused')),
    CHECK (length(id) <= 64),
    CHECK (length(reason) <= 1024),
    CHECK (length(actor) <= 128)
);

CREATE FUNCTION release_control.reject_promotion_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release_control.promotions is append-only: promotion decisions (including refusals) are immutable evidence'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER promotions_append_only
    BEFORE UPDATE OR DELETE ON release_control.promotions
    FOR EACH ROW EXECUTE FUNCTION release_control.reject_promotion_mutation();

-- ---------------------------------------------------------------------------
-- Active deployments: THE single pointer per hosting environment.
-- Updates happen ONLY through the governed store transaction
-- (activation/rollback); deletion is unrepresentable.
-- ---------------------------------------------------------------------------

CREATE TABLE release_control.active_deployments (
    environment            text PRIMARY KEY,
    release_id             text NOT NULL REFERENCES release_control.releases (release_id),
    deployment_identity_id text NOT NULL,
    activated_at           timestamptz NOT NULL,
    activated_by           text NOT NULL,
    CHECK (environment IN ('local', 'preview', 'staging', 'production')),
    CHECK (deployment_identity_id ~ '^[0-9a-f]{64}$'),
    CHECK (length(activated_by) <= 128)
);

CREATE FUNCTION release_control.reject_active_deployment_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release_control.active_deployments rows are never deleted: the pointer moves (activate/rollback) through the governed release-control paths only'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER active_deployments_no_delete
    BEFORE DELETE ON release_control.active_deployments
    FOR EACH ROW EXECUTE FUNCTION release_control.reject_active_deployment_delete();

-- ---------------------------------------------------------------------------
-- Rollbacks: the append-only deployment-state rollback journal.
-- A rollback event and the pointer flip happen in ONE store
-- transaction; NOTHING outside release_control is touched.
-- ---------------------------------------------------------------------------

CREATE TABLE release_control.rollbacks (
    id              text PRIMARY KEY,
    environment     text NOT NULL,
    from_release_id text NOT NULL,
    to_release_id   text NOT NULL,
    reason          text NOT NULL,
    actor           text NOT NULL,
    recorded_at     timestamptz NOT NULL,
    CHECK (environment IN ('local', 'preview', 'staging', 'production')),
    CHECK (length(id) <= 64),
    CHECK (length(reason) <= 1024),
    CHECK (length(actor) <= 128),
    CHECK (from_release_id <> to_release_id)
);

CREATE FUNCTION release_control.reject_rollback_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'release_control.rollbacks is append-only: rollback events are immutable evidence'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER rollbacks_append_only
    BEFORE UPDATE OR DELETE ON release_control.rollbacks
    FOR EACH ROW EXECUTE FUNCTION release_control.reject_rollback_mutation();
