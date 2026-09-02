-- WORK-020 — Learned execution planning and automatic policy
-- optimization (LRN-002): the learned planning-policy axis.
--
-- The durable state of the learned planning-policy lifecycle: the
-- versioned immutable route-preference POLICY artifacts (mined from
-- the telemetry population), the immutable shadow/canary EVALUATION
-- records (revision-bound evidence with honest metrics), and the
-- append-only PUBLICATION journal (the explicit deployment state —
-- which policy version is active in which mode).
--
-- LEARNING IS OBSERVATIONAL (the §10 non-authority invariant,
-- preserved from 0009/0010): no table here references policy, budget,
-- capability or execution STATE as a writable target. The only
-- cross-module references are READ-ONLY bindings:
--   * (application_id, tenant_id) -> applications.applications —
--     tenant identity is never dropped;
--   * (policy_id, application_id) -> learning.learned_planning_policies
--     — an evaluation/publication can only ever point at a policy of
--     ITS OWN application.
-- There is NO policy/capability/budget/verification/tool-runtime
-- surface anywhere in this migration, and no FK to any of them. A
-- learned planning policy is ADVISORY EVIDENCE plus a deployment
-- journal: it carries ONLY route preferences (ranked subjects with
-- observed metrics) and is structurally incapable of expressing a
-- policy restriction (the policies module's restriction-vocabulary
-- boundary scan enforces that mechanically at the consumer seam).
--
-- Physical invariants enforced here (the 0009/0010 discipline —
-- violations are UNREPRESENTABLE, not merely discouraged):
--
--   * policy versions are IMMUTABLE VERSIONED rows: UNIQUE
--     (application_id, policy_version) arbitrates concurrent
--     generation (the scorecard/recommendation-set version-arbitration
--     pattern); rows are never updated or deleted (history is
--     physical — rollback is a PUBLICATION of a prior version, never
--     a rewrite);
--   * the preferences jsonb is CHECK-bound non-empty; the per-entry
--     shapes (ranked subjects meeting the frozen population floor,
--     non-empty source-execution/evidence provenance, the honest
--     confidence vocabulary) are enforced by the domain's closed-shape
--     validation — the physical CHECKs pin the container shapes and
--     vocabulary anchors (the 0009/0010 discipline);
--   * the rollback metadata columns record the deterministic rollback
--     target (a STRICTLY earlier version or the honest first-version
--     null) — CHECK-bound;
--   * evaluation records are IMMUTABLE: kind is CHECK-bound to the
--     shadow/canary vocabulary, status to the honest status
--     vocabulary; a CANARY evaluation must carry a canary binding and
--     cannot be 'insufficient-evidence' (the ran-in-canary proof);
--     the basis jsonb must record a versioned scorecard basis or the
--     honest 'none' basis (revision-bound evidence). NOTE: every
--     jsonb-probing CHECK is written NULL-SAFE (COALESCE / IS NOT NULL
--     guards) — a bare `x <> 'y'` / `jsonb_typeof(x) = ...` probe
--     evaluates to NULL (satisfied) when x IS NULL, which would
--     silently admit a canary evaluation without its binding;
--   * the publication journal is APPEND-ONLY: publication_id text
--     PRIMARY KEY converges retried requests; publication_seq
--     (identity column) orders the journal — the LATEST entry per
--     application is the single active pointer (concurrent
--     publications serialize; only one active publication exists, and
--     the pointer is derived, never duplicated); mode is CHECK-bound
--     to the canary/promoted vocabulary (shadow is PRE-publication
--     evaluation and is unrepresentable as a publication mode);
--     evaluation_evidence is CHECK-bound non-empty (every publication
--     carries revision-bound evaluation evidence — the explicit
--     publication gate's physical half);
--   * rows are NEVER updated or deleted (immutability triggers —
--     history and evidence are physical).
--
-- Migration-version discipline (the parallel-wave collision rule):
-- the live inventory at authoring time is 0001..0014 and 0016
-- (0016 is WORK-022's opportunity-analysis migration). 0015 is
-- BURNED — it is WORK-019's owned number (its file is absent from
-- the frozen-base tree; the worktree reality is documented in the
-- WORK-020 evidence file). THIS migration claims 0017 for WORK-020
-- (the sibling WORK-024 of the current parallel wave claims 0018).
-- No other in-flight Work Order claims 0017.
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — trigger function bodies are single lines.

-- ---------------------------------------------------------------------------
-- Versioned immutable learned planning-policy artifacts (learning-owned).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.learned_planning_policies (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    policy_version integer NOT NULL,
    analysis_version integer NOT NULL,
    telemetry_schema_version integer NOT NULL,
    population_fingerprint text NOT NULL,
    evaluation_window_from timestamptz,
    evaluation_window_to timestamptz NOT NULL,
    total_population integer NOT NULL,
    preferences   jsonb NOT NULL,
    rollback_to_policy_version integer,
    prior_policy_digest text,
    rollback_note text NOT NULL,
    generated_at  timestamptz NOT NULL,
    digest        text NOT NULL,
    CONSTRAINT learned_policies_version_positive CHECK (policy_version >= 1),
    CONSTRAINT learned_policies_analysis_version_positive CHECK (analysis_version >= 1),
    CONSTRAINT learned_policies_telemetry_schema_positive CHECK (telemetry_schema_version >= 1),
    CONSTRAINT learned_policies_population_positive CHECK (total_population >= 1),
    CONSTRAINT learned_policies_preferences_shape CHECK (
        jsonb_typeof(preferences) = 'array' AND jsonb_array_length(preferences) >= 1
    ),
    -- The per-entry shapes (ranked subjects meeting the population
    -- floor, non-empty provenance) are enforced by the domain's
    -- closed-shape validation; these CHECKs pin the container shapes
    -- and vocabulary anchors (the 0009/0010 discipline).
    CONSTRAINT learned_policies_fingerprint_nonempty CHECK (length(population_fingerprint) BETWEEN 1 AND 128),
    CONSTRAINT learned_policies_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    CONSTRAINT learned_policies_note_nonempty CHECK (length(rollback_note) BETWEEN 1 AND 1024),
    -- Deterministic rollback metadata: the target is a STRICTLY EARLIER
    -- version (or the honest first-version NULL), with the prior digest.
    CONSTRAINT learned_policies_rollback_earlier CHECK (
        rollback_to_policy_version IS NULL
        OR (
            rollback_to_policy_version >= 1
            AND rollback_to_policy_version < policy_version
            AND length(prior_policy_digest) BETWEEN 1 AND 128
        )
    ),
    CONSTRAINT learned_policies_rollback_digest_pair CHECK (
        (rollback_to_policy_version IS NULL AND prior_policy_digest IS NULL)
        OR (rollback_to_policy_version IS NOT NULL AND prior_policy_digest IS NOT NULL)
    ),
    -- Append-only version arbitration: UNIQUE (application, version).
    CONSTRAINT learned_policies_version_unique UNIQUE (application_id, policy_version),
    -- composite FK target for the evaluation/publication bindings
    CONSTRAINT learned_policies_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX learned_policies_scope_listing
    ON learning.learned_planning_policies (application_id, tenant_id, policy_version DESC);

-- Policy versions are immutable history (rollback is a PUBLICATION of
-- a prior version, never a rewrite; generation never updates — a new
-- population is a NEW version).
CREATE OR REPLACE FUNCTION learning.learned_policies_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.learned_planning_policies rows are immutable (policy % version %)', OLD.id, OLD.policy_version; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER learned_policies_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.learned_planning_policies
    FOR EACH ROW EXECUTE FUNCTION learning.learned_policies_immutable();

-- ---------------------------------------------------------------------------
-- Immutable shadow/canary evaluation records (revision-bound evidence).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.learned_policy_evaluations (
    evaluation_id text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    policy_id     uuid NOT NULL,
    policy_version integer NOT NULL,
    evaluation_class text NOT NULL,
    status        text NOT NULL,
    verdict       text,
    metrics       jsonb,
    comparison    jsonb,
    basis         jsonb NOT NULL,
    canary_binding jsonb,
    evidence_refs jsonb NOT NULL,
    source_execution_ids jsonb NOT NULL,
    evaluated_at  timestamptz NOT NULL,
    schema_version integer NOT NULL,
    CONSTRAINT learned_evaluations_class_vocabulary CHECK (
        evaluation_class IN ('shadow', 'canary')
    ),
    CONSTRAINT learned_evaluations_status_vocabulary CHECK (
        status IN ('insufficient-evidence', 'inconclusive', 'evaluated')
    ),
    CONSTRAINT learned_evaluations_verdict_vocabulary CHECK (
        verdict IS NULL OR verdict IN ('prefer-learned', 'prefer-baseline', 'inconclusive')
    ),
    CONSTRAINT learned_evaluations_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT learned_evaluations_version_positive CHECK (policy_version >= 1),
    CONSTRAINT learned_evaluations_basis_shape CHECK (jsonb_typeof(basis) = 'object'),
    CONSTRAINT learned_evaluations_basis_kind_vocabulary CHECK (
        COALESCE(basis->>'kind', '') IN ('scorecard', 'none')
    ),
    -- A scorecard basis must carry the full POSITIVE version anchors
    -- (revision-bound evidence — an unversioned basis is unrepresentable).
    -- NULL-SAFE: COALESCE forces missing keys to '' (a missing anchor
    -- must FAIL, never evaluate to NULL-satisfied).
    CONSTRAINT learned_evaluations_scorecard_basis_versioned CHECK (
        COALESCE(basis->>'kind', '') = 'none'
        OR (
            COALESCE(basis->>'scorecardVersion', '') ~ '^[1-9][0-9]*$'
            AND COALESCE(basis->>'definitionVersion', '') ~ '^[1-9][0-9]*$'
            AND COALESCE(basis->>'telemetrySchemaVersion', '') ~ '^[1-9][0-9]*$'
            AND length(COALESCE(basis->>'scorecardId', '')) >= 1
            AND length(COALESCE(basis->>'definitionId', '')) >= 1
            AND length(COALESCE(basis->>'populationWindowTo', '')) >= 1
        )
    ),
    CONSTRAINT learned_evaluations_none_basis_honest CHECK (
        COALESCE(basis->>'kind', '') <> 'none' OR status = 'insufficient-evidence'
    ),
    -- A CANARY evaluation MUST bind the exact canary publication it
    -- observed, and it cannot be 'insufficient-evidence' (the
    -- ran-in-canary proof — a canary evaluation observes outcomes).
    -- NULL-SAFE: `canary_binding IS NOT NULL` guards the jsonb probes
    -- (a NULL binding must FAIL, never evaluate to NULL-satisfied).
    CONSTRAINT learned_evaluations_canary_binding_required CHECK (
        evaluation_class <> 'canary'
        OR (
            canary_binding IS NOT NULL
            AND jsonb_typeof(canary_binding) = 'object'
            AND length(COALESCE(canary_binding->>'publicationId', '')) >= 1
            AND length(COALESCE(canary_binding->>'publishedAt', '')) >= 1
            AND status <> 'insufficient-evidence'
        )
    ),
    CONSTRAINT learned_evaluations_canary_binding_canary_only CHECK (
        evaluation_class = 'canary' OR canary_binding IS NULL
    ),
    CONSTRAINT learned_evaluations_insufficient_no_verdict CHECK (
        status <> 'insufficient-evidence' OR verdict IS NULL
    ),
    CONSTRAINT learned_evaluations_evidence_shape CHECK (jsonb_typeof(evidence_refs) = 'array'),
    CONSTRAINT learned_evaluations_sources_shape CHECK (jsonb_typeof(source_execution_ids) = 'array'),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- An evaluation can only point at a policy of ITS OWN application.
    FOREIGN KEY (policy_id, application_id)
        REFERENCES learning.learned_planning_policies (id, application_id)
);

CREATE INDEX learned_evaluations_scope_listing
    ON learning.learned_policy_evaluations (application_id, tenant_id, policy_id, evaluated_at DESC);

-- Evaluation records are immutable evidence (append-only).
CREATE OR REPLACE FUNCTION learning.learned_evaluations_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.learned_policy_evaluations rows are immutable (evaluation %)', OLD.evaluation_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER learned_evaluations_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.learned_policy_evaluations
    FOR EACH ROW EXECUTE FUNCTION learning.learned_evaluations_immutable();

-- ---------------------------------------------------------------------------
-- The append-only publication journal (the explicit deployment state —
-- DISTINCT from history by design: publication/rollback append entries,
-- they never rewrite policy versions, evaluations or prior entries).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.learned_policy_publication_log (
    publication_id text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    policy_id     uuid NOT NULL,
    policy_version integer NOT NULL,
    publication_mode text NOT NULL,
    publication_reason text NOT NULL,
    evaluation_evidence jsonb NOT NULL,
    publication_seq bigint GENERATED ALWAYS AS IDENTITY,
    published_at  timestamptz NOT NULL,
    published_by  text NOT NULL,
    publication_schema_version integer NOT NULL,
    CONSTRAINT learned_publication_mode_vocabulary CHECK (
        publication_mode IN ('canary', 'promoted')
    ),
    CONSTRAINT learned_publication_reason_vocabulary CHECK (
        publication_reason IN ('initial', 'rollback', 'refresh')
    ),
    CONSTRAINT learned_publication_version_positive CHECK (policy_version >= 1),
    CONSTRAINT learned_publication_schema_version_positive CHECK (publication_schema_version >= 1),
    -- The explicit publication gate's physical half: EVERY publication
    -- carries revision-bound evaluation evidence.
    CONSTRAINT learned_publication_evidence_nonempty CHECK (
        jsonb_typeof(evaluation_evidence) = 'array'
        AND jsonb_array_length(evaluation_evidence) >= 1
    ),
    -- The per-reference shape (evaluation id/class/digest/evaluatedAt)
    -- is enforced by the domain's closed-shape validation; this CHECK
    -- pins the container shape (the 0010 discipline).
    CONSTRAINT learned_publication_actor_nonempty CHECK (length(published_by) BETWEEN 1 AND 256),
    -- Journal order is the serialization: the latest entry per
    -- application is the single active pointer (UNIQUE on the identity
    -- column; the same publication request retries converge on the
    -- PRIMARY KEY).
    CONSTRAINT learned_publication_seq_unique UNIQUE (publication_seq),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- A publication can only point at a policy of ITS OWN application.
    FOREIGN KEY (policy_id, application_id)
        REFERENCES learning.learned_planning_policies (id, application_id)
);

CREATE INDEX learned_publication_scope_listing
    ON learning.learned_policy_publication_log (application_id, tenant_id, publication_seq);

-- The journal is append-only evidence (publication history is never
-- rewritten — rollback appends a 'rollback' entry).
CREATE OR REPLACE FUNCTION learning.learned_publication_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.learned_policy_publication_log rows are immutable (publication %)', OLD.publication_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER learned_publication_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.learned_policy_publication_log
    FOR EACH ROW EXECUTE FUNCTION learning.learned_publication_immutable();
