-- WORK-017 — Tool-composition learning (recommendation sets and the
-- activation journal).
--
-- The durable state of the tool-composition learning axis (the §19
-- "tool sequence" learning surface, ADR-0005): the versioned immutable
-- recommendation SETS (the ranked tool-composition recommendations
-- mined from the telemetry population) and the append-only ACTIVATION
-- journal (the deployment state — which set is active).
--
-- LEARNING IS OBSERVATIONAL (the §10 non-authority invariant,
-- preserved from 0009): no table here references policy, budget,
-- capability or execution STATE as a writable target. The only
-- cross-module references are READ-ONLY bindings:
--   * (application_id, tenant_id) -> applications.applications —
--     tenant identity is never dropped (M25);
--   * (set_id, application_id) -> learning.composition_recommendation_sets
--     — an activation can only ever point at a set of ITS OWN
--     application (cross-application activation is unrepresentable).
-- There is NO policy/capability/budget/verification/tool-runtime
-- surface anywhere in this migration, and no FK to any of them. A
-- recommendation is ADVISORY EVIDENCE: the planner, policy, capability,
-- budget and verification authorities remain mandatory before any
-- execution (recommendation ≠ authorization).
--
-- Physical invariants enforced here (the 0009 discipline — violations
-- are UNREPRESENTABLE, not merely discouraged):
--
--   * recommendation sets are IMMUTABLE VERSIONED rows: UNIQUE
--     (application_id, set_version) arbitrates concurrent generation
--     (the scorecard version-arbitration pattern); rows are never
--     updated or deleted (M15's history half — rollback is an
--     ACTIVATION of a prior set, never a rewrite);
--   * the activation journal is APPEND-ONLY: the same activation_id
--     converges (UNIQUE — a retried activation request replays);
--     activation_seq (identity column) orders the journal — the
--     LATEST entry per application is the single active pointer
--     (§22: concurrent activations serialize; only one active set
--     exists, and the pointer is derived, never duplicated);
--   * every recommendation inside the set jsonb carries MANDATORY
--     provenance: the per-entry shape is validated in the domain
--     (closed-shape validation) and the physical CHECKs pin the
--     vocabulary anchors (status/reason classes, non-empty
--     source-execution and evidence arrays are enforced by the domain
--     validation + the set digest; the SQL-level CHECKs pin the
--     container shapes and the closed status vocabulary);
--   * the recommendation set records its evaluation window, its
--     population fingerprint (replay identity) and its digest
--     (integrity for consumers);
--   * rows are NEVER updated or deleted (immutability triggers —
--     history is physical).
--
-- Migration-version discipline (the collision rule): the live
-- inventory at authoring time is 0001..0009 (all merged; 0009 is
-- WORK-014's learning migration). This migration claims 0010 — the
-- next valid non-conflicting version. No in-flight/unmerged Work
-- Order claims any migration number (the only open PR at pickup
-- carried zero migrations).
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — trigger function bodies are single lines.

-- ---------------------------------------------------------------------------
-- Versioned immutable composition recommendation sets (learning-owned).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.composition_recommendation_sets (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    set_version   integer NOT NULL,
    analysis_version integer NOT NULL,
    telemetry_schema_version integer NOT NULL,
    population_fingerprint text NOT NULL,
    evaluation_window_from timestamptz,
    evaluation_window_to timestamptz NOT NULL,
    total_population integer NOT NULL,
    recommendations jsonb NOT NULL,
    generated_at   timestamptz NOT NULL,
    digest         text NOT NULL,
    CONSTRAINT composition_sets_version_positive CHECK (set_version >= 1),
    CONSTRAINT composition_sets_analysis_version_positive CHECK (analysis_version >= 1),
    CONSTRAINT composition_sets_telemetry_schema_positive CHECK (telemetry_schema_version >= 1),
    CONSTRAINT composition_sets_population_positive CHECK (total_population >= 1),
    CONSTRAINT composition_sets_recommendations_shape CHECK (jsonb_typeof(recommendations) = 'array'),
    CONSTRAINT composition_sets_fingerprint_nonempty CHECK (length(population_fingerprint) BETWEEN 1 AND 128),
    CONSTRAINT composition_sets_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    -- Append-only version arbitration: UNIQUE (application, version).
    CONSTRAINT composition_sets_version_unique UNIQUE (application_id, set_version),
    -- composite FK target for the activation binding
    CONSTRAINT composition_sets_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX composition_sets_scope_listing
    ON learning.composition_recommendation_sets (application_id, tenant_id, set_version DESC);

-- Sets are immutable history (M15: rollback never rewrites; generation
-- never updates — a new population is a NEW version).
CREATE OR REPLACE FUNCTION learning.composition_sets_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.composition_recommendation_sets rows are immutable (set % version %)', OLD.id, OLD.set_version; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER composition_sets_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.composition_recommendation_sets
    FOR EACH ROW EXECUTE FUNCTION learning.composition_sets_immutable();

-- ---------------------------------------------------------------------------
-- The append-only activation journal (the deployment state — DISTINCT
-- from history by design: activation/rollback append entries, they
-- never rewrite sets or prior entries).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.composition_activation_log (
    activation_id text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    set_id        uuid NOT NULL,
    set_version   integer NOT NULL,
    activation_seq bigint GENERATED ALWAYS AS IDENTITY,
    activated_at  timestamptz NOT NULL,
    activated_by  text NOT NULL,
    reason        text NOT NULL,
    CONSTRAINT composition_activation_version_positive CHECK (set_version >= 1),
    CONSTRAINT composition_activation_actor_nonempty CHECK (length(activated_by) BETWEEN 1 AND 256),
    CONSTRAINT composition_activation_reason_vocabulary CHECK (
        reason IN ('initial', 'rollback', 'refresh')
    ),
    -- Journal order is the serialization: the latest entry per
    -- application is the single active pointer (UNIQUE on the identity
    -- column; the same activation request retries converge on the
    -- PRIMARY KEY).
    CONSTRAINT composition_activation_seq_unique UNIQUE (activation_seq),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- An activation can only point at a set of ITS OWN application.
    FOREIGN KEY (set_id, application_id)
        REFERENCES learning.composition_recommendation_sets (id, application_id)
);

CREATE INDEX composition_activation_scope_listing
    ON learning.composition_activation_log (application_id, tenant_id, activation_seq);

-- The journal is append-only evidence (activation history is never
-- rewritten — rollback appends a 'rollback' entry).
CREATE OR REPLACE FUNCTION learning.composition_activation_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.composition_activation_log rows are immutable (activation %)', OLD.activation_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER composition_activation_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.composition_activation_log
    FOR EACH ROW EXECUTE FUNCTION learning.composition_activation_immutable();
