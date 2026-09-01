-- WORK-022 — Codebase AI opportunity analysis and selective human
-- evaluation (migration 0016).
--
-- MIGRATION-NUMBER CLAIM (the parallel-wave collision rule, the
-- WORK-018 §"Migration discipline" pattern): live inventory on main at
-- authoring = 0001..0014. The wave pre-assigned numbers by dispatch
-- order: WORK-019 claims 0015, WORK-022 claims 0016 (THIS file). The
-- claim is pinned here, in docs/work-items/WORK-022.md and asserted by
-- tests/architecture/opportunity-analysis-boundary.test.ts; sibling
-- claims are never renumbered and file gaps are legal pre-merge (the
-- runner applies in ascending order and tolerates gaps).
--
-- The durable state of the DTR-005/HUM-001..003 advisory axis (the
-- learning module's own evidence tables — tenant-scoped, immutable,
-- never authority):
--
--   * learning.opportunity_analyses — one immutable analysis per
--     analysis EXECUTION (UNIQUE execution_id: "Analysis is an
--     Execution" — the executions authority creates + policy-admits
--     the execution BEFORE this row can exist; FK to
--     executions.executions). Repository/revision provenance is
--     CHECK-bound non-empty (M11/M12);
--   * learning.opportunity_findings — the advisory findings (state
--     CHECK 'advisory' | 'candidate' | 'verified'; 'promoted' is
--     UNREPRESENTABLE — promotion is owned by the external
--     validation/promotion gate, §18 no-auto-promotion). Insert state
--     is 'advisory' (enforced by the insert_state CHECK: a row may
--     only be BORN advisory); the ONLY legal UPDATE is the forward
--     single-step state advance, and only when a matching journal row
--     exists in opportunity_finding_transitions (the coupling
--     trigger). deterministic_equivalence potential is CHECK-bound to
--     'none' | 'candidate-replacement' — 'verified-equivalent' is
--     UNREPRESENTABLE at insert (M15/M16: candidate != verified);
--   * learning.opportunity_prompts — the selective human-evaluation
--     requests. PHYSICAL VALUE-OF-INFORMATION GATE (M24):
--     CHECK (expected_information_gain > user_friction_threshold) — a
--     prompt that does not justify its user friction is uninsertable;
--   * learning.opportunity_ratings — immutable evaluation evidence
--     (§14). The answer vocabulary is CHECK-bound PREFERENCE-ONLY
--     (M10: no PASS/FAIL verification vocabulary can be fabricated by
--     a rating). Durable identity (finding_id, rater, question_kind):
--     duplicates converge in the adapter, conflicts fail closed;
--   * learning.opportunity_finding_transitions — the append-only
--     state journal. CHECK (from,to) is one of the two legal
--     single-step forward edges; to_state='verified' REQUIRES
--     evidence_kind='verified-equivalence' AND comparison_status
--     'PASS' AND a non-empty compared revision AND populations
--     comparable (M15/M16/M28/M14 — the physical twins of the domain
--     legality oracle).
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE TABLE learning.opportunity_analyses (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    repository    text NOT NULL,
    revision      text NOT NULL,
    analysis_version integer NOT NULL,
    execution_graph jsonb NOT NULL,
    friction_config jsonb NOT NULL,
    finding_count integer NOT NULL,
    prompt_count  integer NOT NULL,
    digest        text NOT NULL,
    fingerprint   text NOT NULL,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    CONSTRAINT analyses_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT analyses_version_positive CHECK (analysis_version >= 1),
    CONSTRAINT analyses_finding_count_nonnegative CHECK (finding_count >= 0),
    CONSTRAINT analyses_prompt_count_nonnegative CHECK (prompt_count >= 0),
    CONSTRAINT analyses_repository_nonempty CHECK (length(repository) BETWEEN 1 AND 512),
    CONSTRAINT analyses_revision_nonempty CHECK (length(revision) BETWEEN 1 AND 256),
    CONSTRAINT analyses_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    CONSTRAINT analyses_fingerprint_nonempty CHECK (length(fingerprint) BETWEEN 1 AND 128),
    CONSTRAINT analyses_graph_shape CHECK (jsonb_typeof(execution_graph) = 'object'),
    CONSTRAINT analyses_friction_shape CHECK (jsonb_typeof(friction_config) = 'object'),
    -- M12/M28: source revision binding is physical, never dropped.
    CONSTRAINT analyses_id_application_unique UNIQUE (id, application_id),
    -- THE ANALYSIS-IS-AN-EXECUTION BINDING: one authoritative analysis
    -- per analysis execution (M2/M26); retries converge through the
    -- unique-index arbitration.
    CONSTRAINT analyses_execution_unique UNIQUE (execution_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX analyses_scope_listing
    ON learning.opportunity_analyses (application_id, tenant_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION learning.opportunity_analyses_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.opportunity_analyses rows are immutable (analysis %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_analyses_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.opportunity_analyses
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_analyses_immutable();

CREATE TABLE learning.opportunity_findings (
    id            uuid PRIMARY KEY,
    analysis_id   uuid NOT NULL,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    finding_class text NOT NULL,
    state         text NOT NULL DEFAULT 'advisory',
    target_node_ids jsonb NOT NULL,
    reason_codes  jsonb NOT NULL,
    evidence_refs jsonb NOT NULL,
    provenance    jsonb NOT NULL,
    confidence    jsonb NOT NULL,
    cost_impact   jsonb NOT NULL,
    latency_impact jsonb NOT NULL,
    deterministic_equivalence jsonb NOT NULL,
    recommendation jsonb NOT NULL,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    CONSTRAINT findings_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT findings_class_vocabulary CHECK (
        finding_class IN ('ai-addition','ai-removal','deterministic-replacement','tool-replacement','tool-composition','hybrid-decomposition','context-enhancement','verification-enhancement','human-evaluation')
    ),
    -- §18 NO-AUTO-PROMOTION: 'promoted' is not a state of this module.
    CONSTRAINT findings_state_vocabulary CHECK (state IN ('advisory','candidate','verified')),
    -- A finding is BORN advisory (the insert guard trigger below); only
    -- the guarded forward transition can change the state.
    CONSTRAINT findings_targets_nonempty CHECK (
        jsonb_typeof(target_node_ids) = 'array' AND jsonb_array_length(target_node_ids) >= 1
    ),
    CONSTRAINT findings_reasons_nonempty CHECK (
        jsonb_typeof(reason_codes) = 'array' AND jsonb_array_length(reason_codes) >= 1
    ),
    -- M11: every finding carries non-empty evidence references.
    CONSTRAINT findings_evidence_nonempty CHECK (
        jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) >= 1
    ),
    CONSTRAINT findings_provenance_shape CHECK (
        jsonb_typeof(provenance) = 'object'
        AND length(provenance->>'repository') >= 1
        AND length(provenance->>'revision') >= 1
    ),
    CONSTRAINT findings_confidence_shape CHECK (
        jsonb_typeof(confidence) = 'object'
        AND confidence->>'level' IN ('high','medium','low','inconclusive')
    ),
    -- M22/M23: the honest impact basis vocabulary.
    CONSTRAINT findings_cost_basis_vocabulary CHECK (cost_impact->>'basis' IN ('measured','estimated','unknown')),
    CONSTRAINT findings_latency_basis_vocabulary CHECK (latency_impact->>'basis' IN ('measured','estimated','unknown')),
    -- M15/M16: 'verified-equivalent' is UNREPRESENTABLE at insert —
    -- verified equivalence is reachable only through the evidence-
    -- gated transition (the state column + the journal).
    CONSTRAINT findings_equivalence_vocabulary CHECK (
        deterministic_equivalence->>'potential' IN ('none','candidate-replacement')
    ),
    CONSTRAINT findings_recommendation_shape CHECK (
        jsonb_typeof(recommendation) = 'object'
        AND length(recommendation->>'strategy') >= 1
        AND jsonb_array_length(COALESCE(recommendation->'validationSteps','[]'::jsonb)) >= 1
    ),
    CONSTRAINT findings_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (analysis_id, application_id)
        REFERENCES learning.opportunity_analyses (id, application_id)
);

CREATE INDEX findings_scope_listing
    ON learning.opportunity_findings (application_id, tenant_id, analysis_id);

-- A finding is born ADVISORY only (the insert guard).
CREATE OR REPLACE FUNCTION learning.opportunity_findings_insert_guard() RETURNS trigger AS $$ BEGIN IF NEW.state <> 'advisory' THEN RAISE EXCEPTION 'findings are born advisory only (state % is not insertable)', NEW.state; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_findings_insert_guard
    BEFORE INSERT ON learning.opportunity_findings
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_findings_insert_guard();

-- The ONLY legal UPDATE is the forward state advance, and only when a
-- matching journal row exists (the domain legality oracle's physical
-- twin — M8/M15/M16/M18).
CREATE OR REPLACE FUNCTION learning.opportunity_findings_state_guard() RETURNS trigger AS $$ BEGIN IF (OLD.state, NEW.state) NOT IN (('advisory','candidate'),('candidate','verified')) THEN RAISE EXCEPTION 'illegal finding state advance % -> % (forward single-step only; promoted is not a learning state)', OLD.state, NEW.state; END IF; IF NOT EXISTS (SELECT 1 FROM learning.opportunity_finding_transitions t WHERE t.finding_id = OLD.id AND t.to_state = NEW.state) THEN RAISE EXCEPTION 'finding state advance requires a matching transition journal row (evidence-gated, never silent)'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_findings_state_guard
    BEFORE UPDATE ON learning.opportunity_findings
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_findings_state_guard();

CREATE OR REPLACE FUNCTION learning.opportunity_findings_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.opportunity_findings rows are immutable (finding %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_findings_immutable_guard
    BEFORE DELETE ON learning.opportunity_findings
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_findings_immutable();

CREATE TABLE learning.opportunity_prompts (
    id            uuid PRIMARY KEY,
    analysis_id   uuid NOT NULL,
    finding_id    uuid NOT NULL,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    question_kind text NOT NULL,
    question      text NOT NULL,
    expected_information_gain numeric NOT NULL,
    user_friction_threshold numeric NOT NULL,
    basis         jsonb NOT NULL,
    emitted_at    timestamptz NOT NULL,
    schema_version integer NOT NULL,
    CONSTRAINT prompts_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT prompts_question_kind_vocabulary CHECK (
        question_kind IN ('pair-preference','behavior-preservation','replacement-acceptability')
    ),
    CONSTRAINT prompts_question_nonempty CHECK (length(question) BETWEEN 1 AND 256),
    CONSTRAINT prompts_gain_range CHECK (expected_information_gain >= 0 AND expected_information_gain <= 1),
    CONSTRAINT prompts_friction_range CHECK (user_friction_threshold >= 0 AND user_friction_threshold <= 1),
    -- M24 (physical): a prompt MUST justify its user friction — the
    -- strict value-of-information inequality.
    CONSTRAINT prompts_voi_gate CHECK (expected_information_gain > user_friction_threshold),
    CONSTRAINT prompts_basis_nonempty CHECK (
        jsonb_typeof(basis) = 'array' AND jsonb_array_length(basis) >= 1
    ),
    CONSTRAINT prompts_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (analysis_id, application_id)
        REFERENCES learning.opportunity_analyses (id, application_id),
    FOREIGN KEY (finding_id, application_id)
        REFERENCES learning.opportunity_findings (id, application_id)
);

CREATE INDEX prompts_scope_listing
    ON learning.opportunity_prompts (application_id, tenant_id, analysis_id);

CREATE OR REPLACE FUNCTION learning.opportunity_prompts_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.opportunity_prompts rows are immutable (prompt %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_prompts_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.opportunity_prompts
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_prompts_immutable();

CREATE TABLE learning.opportunity_ratings (
    id            uuid PRIMARY KEY,
    analysis_id   uuid NOT NULL,
    finding_id    uuid NOT NULL,
    counterpart_finding_id uuid,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    prompt_id     uuid,
    rater         text NOT NULL,
    question_kind text NOT NULL,
    answer        text NOT NULL,
    confidence    numeric,
    rationale     text,
    source_revision text NOT NULL,
    context       jsonb NOT NULL,
    evidence_refs jsonb NOT NULL,
    provenance    jsonb NOT NULL,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    fingerprint   text NOT NULL,
    CONSTRAINT ratings_v22_schema_version_positive CHECK (schema_version >= 1),
    -- M10 (physical): the rating answer vocabulary is PREFERENCE-ONLY —
    -- a rating can never fabricate a verification PASS.
    CONSTRAINT ratings_v22_answer_vocabulary CHECK (
        answer IN ('prefer-candidate','prefer-baseline','no-difference','insufficient-information')
    ),
    CONSTRAINT ratings_v22_question_kind_vocabulary CHECK (
        question_kind IN ('pair-preference','behavior-preservation','replacement-acceptability')
    ),
    CONSTRAINT ratings_v22_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    -- M12/M28: the revision the rating was formed against is bound.
    CONSTRAINT ratings_v22_revision_nonempty CHECK (length(source_revision) BETWEEN 1 AND 256),
    CONSTRAINT ratings_v22_rater_nonempty CHECK (length(rater) BETWEEN 1 AND 256),
    CONSTRAINT ratings_v22_context_shape CHECK (
        jsonb_typeof(context) = 'object'
        AND length(context->>'repository') >= 1
        AND jsonb_array_length(COALESCE(context->'targetNodeIds','[]'::jsonb)) >= 1
    ),
    CONSTRAINT ratings_v22_evidence_nonempty CHECK (
        jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) >= 1
    ),
    CONSTRAINT ratings_v22_provenance_shape CHECK (
        jsonb_typeof(provenance) = 'object' AND length(provenance->>'submittedVia') >= 1
    ),
    CONSTRAINT ratings_v22_fingerprint_nonempty CHECK (length(fingerprint) BETWEEN 1 AND 128),
    -- Durable rating identity: duplicates converge; conflicts fail closed.
    CONSTRAINT ratings_v22_identity_unique UNIQUE (finding_id, rater, question_kind),
    CONSTRAINT ratings_v22_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (analysis_id, application_id)
        REFERENCES learning.opportunity_analyses (id, application_id),
    FOREIGN KEY (finding_id, application_id)
        REFERENCES learning.opportunity_findings (id, application_id),
    -- Ratings are attributable to the ANALYSIS execution (§14).
    FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX ratings_v22_scope_listing
    ON learning.opportunity_ratings (application_id, tenant_id, analysis_id);

CREATE OR REPLACE FUNCTION learning.opportunity_ratings_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.opportunity_ratings rows are immutable (rating %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_ratings_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.opportunity_ratings
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_ratings_immutable();

-- The transition id is TEXT: content-derived (the service digests the
-- exact transition request — the WORK-017 activation-journal pattern),
-- so the same logical transition retries to the SAME id and converges.
CREATE TABLE learning.opportunity_finding_transitions (
    id            text PRIMARY KEY,
    finding_id    uuid NOT NULL,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    from_state    text NOT NULL,
    to_state      text NOT NULL,
    evidence_kind text NOT NULL,
    evidence_refs jsonb NOT NULL,
    verified_equivalence jsonb,
    requested_by  text NOT NULL,
    recorded_at   timestamptz NOT NULL,
    schema_version integer NOT NULL,
    CONSTRAINT transitions_schema_version_positive CHECK (schema_version >= 1),
    -- The frozen single-step forward table (M16/M18).
    CONSTRAINT transitions_forward_only CHECK (
        (from_state, to_state) IN (('advisory','candidate'),('candidate','verified'))
    ),
    CONSTRAINT transitions_evidence_kind_vocabulary CHECK (
        evidence_kind IN ('rating','verified-equivalence')
    ),
    -- M9 (physical): rating evidence can only ever produce 'candidate'.
    CONSTRAINT transitions_rating_evidence_scope CHECK (
        to_state <> 'candidate' OR evidence_kind = 'rating'
    ),
    -- M15/M16/M28/M14 (physical): verified REQUIRES equivalence
    -- evidence with PASS status, a bound compared revision and
    -- comparable populations.
    CONSTRAINT transitions_verified_requires_equivalence CHECK (
        to_state <> 'verified'
        OR (
            evidence_kind = 'verified-equivalence'
            AND jsonb_typeof(verified_equivalence) = 'object'
            AND verified_equivalence->>'comparisonStatus' = 'PASS'
            AND length(verified_equivalence->>'comparedRevision') >= 1
            AND (verified_equivalence->>'populationsComparable')::boolean
        )
    ),
    CONSTRAINT transitions_evidence_nonempty CHECK (
        jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) >= 1
    ),
    CONSTRAINT transitions_requested_by_nonempty CHECK (length(requested_by) BETWEEN 1 AND 256),
    CONSTRAINT transitions_id_nonempty CHECK (length(id) BETWEEN 1 AND 128),
    CONSTRAINT transitions_id_application_unique UNIQUE (id, application_id),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (finding_id, application_id)
        REFERENCES learning.opportunity_findings (id, application_id)
);

CREATE INDEX transitions_scope_listing
    ON learning.opportunity_finding_transitions (application_id, tenant_id, finding_id);

CREATE OR REPLACE FUNCTION learning.opportunity_transitions_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.opportunity_finding_transitions rows are immutable (transition %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER opportunity_transitions_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.opportunity_finding_transitions
    FOR EACH ROW EXECUTE FUNCTION learning.opportunity_transitions_immutable();
