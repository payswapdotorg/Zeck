-- WORK-014 — Learning telemetry, scorecards and shadow evaluation.
--
-- The durable state of the learning axis (LRN-001/TOL-003/INT-006): the
-- execution outcome telemetry (ONE immutable authoritative observation
-- per source execution), the versioned immutable scorecards, the shadow
-- evaluation journal and the user-rating evidence.
--
-- LEARNING IS OBSERVATIONAL (the §10 non-authority invariant): no table
-- here references policy, budget, capability or execution STATE as a
-- writable target. The only cross-module references are READ-ONLY
-- bindings of source identity:
--   * (execution_id, application_id) -> executions.executions — every
--     learned datum is physically bound to its source execution (M10:
--     orphaned "model performance" facts are unrepresentable);
--   * (application_id, tenant_id) -> applications.applications — tenant
--     identity is never dropped (M12: cross-tenant/cross-application
--     learning rows are unrepresentable).
-- There is no FK to verification/policy/budget tables and no writable
-- path to any of them (M2–M6).
--
-- Physical invariants enforced here (the WORK-004..0008 discipline of
-- making violations UNREPRESENTABLE, not merely discouraged):
--
--   * telemetry identity is UNIQUE (execution_id): concurrent duplicate
--     ingestion converges through the unique-index arbitration (M11
--     duplicate-ingestion convergence); conflicting fingerprints are
--     rejected in the service (IDEMPOTENCY_KEY_REUSED) before/after the
--     insert arbitration;
--   * evidence_refs is CHECK-bound non-empty (M11: every learned datum
--     carries evidence references);
--   * the outcome vocabulary is the LEARNING OBSERVATION vocabulary —
--     execution terminal states only (execution-completed | -failed |
--     -cancelled | -expired); verification/provider/tool outcome
--     classes are unrepresentable in this column (they are recorded as
--     separate observation fields);
--   * telemetry rows are NEVER updated or deleted (immutable
--     authoritative observations — physical triggers);
--   * scorecards are immutable versioned rows: UNIQUE (application_id,
--     definition_id, scorecard_version) arbitrates concurrent builds;
--     entries carry per-entry sourceExecutionIds + evidenceRefs
--     (jsonb CHECK non-empty) so every aggregate stays traceable (M10/
--     M11); rows are never updated or deleted (M9: historical
--     scorecards cannot mutate silently);
--   * shadow_evaluations.record_class is CHECK-bound to 'shadow' (M15:
--     a speculative result presented as a production outcome is
--     unrepresentable); status is CHECK-bound to the honest shadow
--     vocabulary; the basis jsonb must record either a versioned
--     scorecard basis or the honest 'none' basis (M13: versioned
--     evaluation basis); rows are immutable;
--   * user ratings are immutable evidence: rating is CHECK-bound to the
--     bounded [1,5] integer scale, provenance is a non-null object,
--     evidence_refs non-empty; UNIQUE (execution_id, evaluator_id,
--     rating_dimension) is the durable identity — duplicates converge,
--     conflicting re-ratings fail closed; rows are never updated or
--     deleted (M16: a rating is evidence, and evidence never rewrites
--     itself);
--   * subgraphs is the DTR-001/DTR-004 identity substrate for future
--     deterministicization discovery (WORK-021 owns the decisions):
--     identity + computation type only, never promotion/rollout state.
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE SCHEMA learning;

-- ---------------------------------------------------------------------------
-- Execution outcome telemetry (owned by the learning module): ONE
-- immutable authoritative observation per source execution.
-- ---------------------------------------------------------------------------

CREATE TABLE learning.execution_telemetry (
    id            uuid PRIMARY KEY,
    execution_id  uuid NOT NULL,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    task_class    text NOT NULL,
    task_profile_digest text,
    context_strategy text,
    capabilities  jsonb NOT NULL,
    plan_id       text NOT NULL,
    plan_revision integer NOT NULL,
    strategy_class text,
    routes        jsonb NOT NULL,
    tools         jsonb NOT NULL,
    environments  jsonb NOT NULL,
    verification  jsonb NOT NULL,
    cost_micro_usd bigint NOT NULL,
    latency_ms    bigint NOT NULL,
    outcome       text NOT NULL,
    evidence_refs jsonb NOT NULL,
    subgraphs     jsonb NOT NULL,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    fingerprint   text NOT NULL,
    CONSTRAINT telemetry_outcome_vocabulary CHECK (
        outcome IN ('execution-completed', 'execution-failed', 'execution-cancelled', 'execution-expired')
    ),
    CONSTRAINT telemetry_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT telemetry_plan_revision_positive CHECK (plan_revision >= 1),
    CONSTRAINT telemetry_cost_nonnegative CHECK (cost_micro_usd >= 0),
    CONSTRAINT telemetry_latency_nonnegative CHECK (latency_ms >= 0),
    CONSTRAINT telemetry_capabilities_shape CHECK (jsonb_typeof(capabilities) = 'array'),
    CONSTRAINT telemetry_routes_shape CHECK (jsonb_typeof(routes) = 'array'),
    CONSTRAINT telemetry_tools_shape CHECK (jsonb_typeof(tools) = 'array'),
    CONSTRAINT telemetry_environments_shape CHECK (jsonb_typeof(environments) = 'array'),
    CONSTRAINT telemetry_verification_shape CHECK (jsonb_typeof(verification) = 'object'),
    CONSTRAINT telemetry_subgraphs_shape CHECK (jsonb_typeof(subgraphs) = 'array'),
    -- M11: every learned datum carries non-empty evidence references.
    CONSTRAINT telemetry_evidence_nonempty CHECK (
        jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) >= 1
    ),
    CONSTRAINT telemetry_task_class_nonempty CHECK (length(task_class) BETWEEN 1 AND 256),
    CONSTRAINT telemetry_plan_id_nonempty CHECK (length(plan_id) BETWEEN 1 AND 256),
    CONSTRAINT telemetry_fingerprint_nonempty CHECK (length(fingerprint) BETWEEN 1 AND 128),
    -- One authoritative observation per source execution.
    CONSTRAINT telemetry_execution_unique UNIQUE (execution_id),
    -- composite FK target for downstream bindings
    CONSTRAINT telemetry_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- M10: the source execution binding is physical.
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX telemetry_population
    ON learning.execution_telemetry (application_id, tenant_id, recorded_at);

CREATE INDEX telemetry_task_class_population
    ON learning.execution_telemetry (application_id, tenant_id, task_class, outcome);

-- Observations are immutable: no update, no delete (the idempotency
-- anchor arbitrates convergence; a conflicting fingerprint fails closed).
CREATE OR REPLACE FUNCTION learning.telemetry_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.execution_telemetry rows are immutable (observation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER telemetry_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.execution_telemetry
    FOR EACH ROW EXECUTE FUNCTION learning.telemetry_immutable();

-- ---------------------------------------------------------------------------
-- Versioned scorecards (owned by the learning module): immutable
-- aggregate snapshots, append-only by version.
-- ---------------------------------------------------------------------------

CREATE TABLE learning.scorecards (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    definition_id text NOT NULL,
    definition_version integer NOT NULL,
    scorecard_version integer NOT NULL,
    telemetry_schema_version integer NOT NULL,
    population_from timestamptz,
    population_to timestamptz NOT NULL,
    total_population integer NOT NULL,
    entries       jsonb NOT NULL,
    computed_at   timestamptz NOT NULL,
    digest        text NOT NULL,
    CONSTRAINT scorecards_definition_version_positive CHECK (definition_version >= 1),
    CONSTRAINT scorecards_version_positive CHECK (scorecard_version >= 1),
    CONSTRAINT scorecards_schema_version_positive CHECK (telemetry_schema_version >= 1),
    CONSTRAINT scorecards_population_positive CHECK (total_population >= 1),
    CONSTRAINT scorecards_entries_shape CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) >= 1),
    CONSTRAINT scorecards_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    CONSTRAINT scorecards_definition_nonempty CHECK (length(definition_id) BETWEEN 1 AND 128),
    -- The version arbitration: concurrent builds converge through this
    -- unique index (the service re-reads the durable winner).
    CONSTRAINT scorecards_version_unique UNIQUE (application_id, definition_id, scorecard_version),
    CONSTRAINT scorecards_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX scorecards_latest
    ON learning.scorecards (application_id, tenant_id, definition_id, scorecard_version DESC);

-- M9: historical scorecards never mutate silently.
CREATE OR REPLACE FUNCTION learning.scorecards_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.scorecards rows are immutable (scorecard % version %)', OLD.id, OLD.scorecard_version; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER scorecards_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.scorecards
    FOR EACH ROW EXECUTE FUNCTION learning.scorecards_immutable();

-- ---------------------------------------------------------------------------
-- Shadow evaluation journal (owned by the learning module): immutable
-- speculative-evaluation records — class 'shadow', never production.
-- ---------------------------------------------------------------------------

CREATE TABLE learning.shadow_evaluations (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    record_class  text NOT NULL,
    proposed      jsonb NOT NULL,
    baseline      jsonb,
    evaluation_basis jsonb NOT NULL,
    proposed_scores jsonb NOT NULL,
    baseline_scores jsonb NOT NULL,
    comparison    jsonb,
    status        text NOT NULL,
    evidence_refs jsonb NOT NULL,
    source_execution_ids jsonb NOT NULL,
    requested_by  text NOT NULL,
    cause         text,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    -- M15: a speculative result is never a production outcome.
    CONSTRAINT shadow_class_pinned CHECK (record_class = 'shadow'),
    CONSTRAINT shadow_status_vocabulary CHECK (
        status IN ('scored', 'insufficient-evidence', 'incompatible-schema', 'no-baseline')
    ),
    CONSTRAINT shadow_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT shadow_proposed_shape CHECK (jsonb_typeof(proposed) = 'object'),
    CONSTRAINT shadow_basis_shape CHECK (jsonb_typeof(evaluation_basis) = 'object'),
    CONSTRAINT shadow_basis_kind_vocabulary CHECK (
        evaluation_basis->>'kind' IN ('scorecard', 'none')
    ),
    -- M13: a scorecard basis must carry the full POSITIVE version anchors.
    CONSTRAINT shadow_scorecard_basis_versioned CHECK (
        evaluation_basis->>'kind' = 'none'
        OR (
            (evaluation_basis->>'scorecardVersion') ~ '^[1-9][0-9]*$'
            AND (evaluation_basis->>'definitionVersion') ~ '^[1-9][0-9]*$'
            AND (evaluation_basis->>'telemetrySchemaVersion') ~ '^[1-9][0-9]*$'
            AND length(evaluation_basis->>'scorecardId') >= 1
            AND length(evaluation_basis->>'definitionId') >= 1
            AND length(evaluation_basis->>'populationWindowTo') >= 1
        )
    ),
    CONSTRAINT shadow_none_basis_honest CHECK (
        evaluation_basis->>'kind' <> 'none' OR status = 'insufficient-evidence'
    ),
    CONSTRAINT shadow_proposed_scores_shape CHECK (jsonb_typeof(proposed_scores) = 'array'),
    CONSTRAINT shadow_baseline_scores_shape CHECK (jsonb_typeof(baseline_scores) = 'array'),
    CONSTRAINT shadow_evidence_shape CHECK (jsonb_typeof(evidence_refs) = 'array'),
    CONSTRAINT shadow_sources_shape CHECK (jsonb_typeof(source_execution_ids) = 'array'),
    CONSTRAINT shadow_requested_by_nonempty CHECK (length(requested_by) BETWEEN 1 AND 256),
    CONSTRAINT shadow_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX shadow_scope_listing
    ON learning.shadow_evaluations (application_id, tenant_id, recorded_at DESC);

-- Shadow records are immutable evidence (append-only).
CREATE OR REPLACE FUNCTION learning.shadow_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.shadow_evaluations rows are immutable (shadow %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER shadow_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.shadow_evaluations
    FOR EACH ROW EXECUTE FUNCTION learning.shadow_immutable();

-- ---------------------------------------------------------------------------
-- User/human ratings (owned by the learning module): immutable evidence,
-- never authority.
-- ---------------------------------------------------------------------------

CREATE TABLE learning.user_ratings (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    target_artifact_ref text,
    evaluator_id  text NOT NULL,
    rating_dimension text NOT NULL,
    rating        integer NOT NULL,
    confidence    numeric,
    rationale     text,
    provenance    jsonb NOT NULL,
    evidence_refs jsonb NOT NULL,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    fingerprint   text NOT NULL,
    CONSTRAINT ratings_scale_bounded CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT ratings_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT ratings_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT ratings_provenance_shape CHECK (jsonb_typeof(provenance) = 'object'),
    CONSTRAINT ratings_evidence_nonempty CHECK (
        jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) >= 1
    ),
    CONSTRAINT ratings_evaluator_nonempty CHECK (length(evaluator_id) BETWEEN 1 AND 256),
    CONSTRAINT ratings_dimension_nonempty CHECK (length(rating_dimension) BETWEEN 1 AND 256),
    CONSTRAINT ratings_fingerprint_nonempty CHECK (length(fingerprint) BETWEEN 1 AND 128),
    -- Durable rating identity: duplicates converge; conflicts fail closed.
    CONSTRAINT ratings_identity_unique UNIQUE (execution_id, evaluator_id, rating_dimension),
    CONSTRAINT ratings_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- M10: ratings are bound to their target execution.
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX ratings_scope_listing
    ON learning.user_ratings (application_id, tenant_id, recorded_at DESC);

-- Ratings are immutable evidence (M16: never rewritten, never authority).
CREATE OR REPLACE FUNCTION learning.ratings_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.user_ratings rows are immutable (rating %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ratings_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.user_ratings
    FOR EACH ROW EXECUTE FUNCTION learning.ratings_immutable();
