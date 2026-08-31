-- WORK-013 — Verification, evaluators and quality gates.
--
-- The durable evidence authority of the verification module: declared
-- criteria (immutable, versioned), the evaluation journal (idempotency
-- authority + durable intent), verification results (immutable,
-- revision/provenance-bound evidence), human evaluation requests
-- (exactly-once answer binding) and candidate comparisons (append-only
-- evidence with preserved candidate identity).
--
-- Physical invariants enforced here (the WORK-004/0004/0005 discipline
-- of making violations UNREPRESENTABLE, not merely discouraged):
--
--   * the RESULT STATUS vocabulary is the VERIFICATION AXIS ONLY:
--     status ∈ {PASS, FAIL, INCONCLUSIVE}. Provider-axis outcome classes
--     and tool-axis outcome classes are physically unrepresentable —
--     "classify a provider success as verification PASS" is rejected by
--     the storage boundary itself (M1/M3);
--   * PASS REQUIRES evidence: `results_pass_requires_evidence` rejects
--     a PASS row with an empty evidence array (M4: missing evidence →
--     PASS is unrepresentable) and `results_pass_requires_criteria`
--     rejects a PASS without its criteria binding (M21);
--   * results are PHYSICALLY append-only — UPDATE and DELETE are
--     rejected by trigger (M23: a verification result mutated after
--     acceptance is unrepresentable); every result carries its
--     evaluator identity AND version (M20) and its provenance
--     evaluation binding (M24: a result detached from its evidence
--     journal is unrepresentable);
--   * criteria are append-only and identity-keyed
--     (application, criterion_id, version);
--   * the evaluation journal is the idempotency anchor: UNIQUE
--     (application_id, evaluation_key); terminal rows (denied |
--     concluded) are immutable; the only legal UPDATE is on an
--     evaluating row (ledger-sequence bookkeeping or the exactly-once
--     finalization evaluating → denied | concluded);
--   * human evaluation requests carry the exactly-once answer binding:
--     the only legal UPDATE is answering an unanswered request once;
--     answered shape is pinned (all-or-none) and decided_by is
--     mandatory on answer (M19: stripped human identity is
--     unrepresentable);
--   * comparisons are append-only; the winner exists IFF the comparison
--     decided (status = PASS) — an INCONCLUSIVE comparison with a
--     winner (a forced pick) is unrepresentable (M16/M22);
--   * tenant scoping uses composite FKs like migrations 0002–0006:
--     (application_id, tenant_id) -> applications.applications and
--     (execution_id, application_id) -> executions.executions, so a
--     cross-tenant or cross-execution evidence row is unrepresentable
--     (M9/M10).
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE SCHEMA verification;

-- ---------------------------------------------------------------------------
-- Declared criteria (owned by the verification module): what "verified"
-- means. Immutable once declared; a new definition is a NEW version.
-- ---------------------------------------------------------------------------

CREATE TABLE verification.criteria (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    criterion_id  text NOT NULL,
    version       integer NOT NULL,
    kind          text NOT NULL,
    required      boolean NOT NULL,
    description   text NOT NULL,
    definition    jsonb NOT NULL,
    declared_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT criteria_kind_vocabulary CHECK (
        kind IN ('schema', 'invariant', 'digest', 'exact-match', 'reference', 'model-judged', 'human-judged')
    ),
    CONSTRAINT criteria_version_positive CHECK (version >= 1),
    CONSTRAINT criteria_criterion_shape CHECK (
        length(criterion_id) BETWEEN 1 AND 200
        AND length(description) BETWEEN 1 AND 2000
    ),
    CONSTRAINT criteria_definition_shape CHECK (jsonb_typeof(definition) = 'object'),
    CONSTRAINT criteria_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT criteria_identity UNIQUE (application_id, criterion_id, version)
);

-- Criteria are append-only (declare a new version; never edit history).
CREATE OR REPLACE FUNCTION verification.criteria_no_mutation() RETURNS trigger AS $$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'verification.criteria rows are never deleted (criterion %)', OLD.criterion_id; ELSE RAISE EXCEPTION 'verification.criteria rows are immutable after declaration (criterion % @ v%)', OLD.criterion_id, OLD.version; END IF; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER criteria_no_mutation_guard
    BEFORE UPDATE OR DELETE ON verification.criteria
    FOR EACH ROW EXECUTE FUNCTION verification.criteria_no_mutation();

-- ---------------------------------------------------------------------------
-- Evaluation journal (owned by the verification module): the governed
-- evaluation boundary — durable intent BEFORE any evaluator runs, the
-- idempotency anchor (one row per logical evaluation), the admission
-- evidence and the concluded outcome. NOT an execution state machine:
-- the statuses are the evaluator/job lifecycle the Work Order allows
-- (denied | evaluating | concluded), never execution lifecycle states.
-- ---------------------------------------------------------------------------

CREATE TABLE verification.evaluations (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    evaluation_key text NOT NULL,
    request_fingerprint text NOT NULL,
    target_kind   text NOT NULL,
    target_ref    text NOT NULL,
    target_revision text,
    status        text NOT NULL,
    denial_reason text,
    criteria_set  jsonb NOT NULL,
    conclusion    jsonb,
    policy_evidence jsonb,
    requested_at  timestamptz NOT NULL DEFAULT now(),
    concluded_at  timestamptz,
    ledger_requested_sequence integer,
    CONSTRAINT evaluations_status_vocabulary CHECK (
        status IN ('denied', 'evaluating', 'concluded')
    ),
    CONSTRAINT evaluations_target_vocabulary CHECK (
        target_kind IN ('execution-output', 'plan-revision', 'artifact', 'tool-output', 'model-output', 'record', 'candidate')
    ),
    CONSTRAINT evaluations_denied_shape CHECK (
        (status = 'denied') = (denial_reason IS NOT NULL)
    ),
    CONSTRAINT evaluations_concluded_shape CHECK (
        (status = 'concluded') = (conclusion IS NOT NULL AND concluded_at IS NOT NULL)
    ),
    CONSTRAINT evaluations_evaluating_shape CHECK (
        (status = 'evaluating') = (denial_reason IS NULL AND conclusion IS NULL AND concluded_at IS NULL)
    ),
    CONSTRAINT evaluations_key_shape CHECK (
        length(evaluation_key) BETWEEN 1 AND 200
        AND length(request_fingerprint) BETWEEN 1 AND 500
        AND length(target_ref) BETWEEN 1 AND 500
    ),
    CONSTRAINT evaluations_criteria_shape CHECK (
        jsonb_typeof(criteria_set) = 'array' AND jsonb_array_length(criteria_set) >= 1
    ),
    CONSTRAINT evaluations_conclusion_shape CHECK (
        conclusion IS NULL OR (
            jsonb_typeof(conclusion) = 'object'
            AND jsonb_typeof(conclusion->'criteriaMet') = 'boolean'
            AND jsonb_typeof(conclusion->'requiredUnmet') = 'array'
        )
    ),
    CONSTRAINT evaluations_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT evaluations_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT evaluations_request_key UNIQUE (application_id, evaluation_key),
    -- Composite-FK anti-ambiguity (the migration 0004/0005 discipline):
    -- results reference (evaluation_id, application_id).
    CONSTRAINT evaluations_id_application_unique UNIQUE (id, application_id)
);

CREATE INDEX evaluations_by_execution
    ON verification.evaluations (application_id, execution_id, requested_at);

-- Rows are never deleted; terminal rows are physically immutable; an
-- evaluating row may only take ledger-sequence bookkeeping or the
-- exactly-once finalization evaluating -> denied | concluded.
CREATE OR REPLACE FUNCTION verification.evaluations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'verification.evaluations rows are never deleted (evaluation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER evaluations_no_delete_guard
    BEFORE DELETE ON verification.evaluations
    FOR EACH ROW EXECUTE FUNCTION verification.evaluations_no_delete();

CREATE OR REPLACE FUNCTION verification.evaluations_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('denied', 'concluded') THEN RAISE EXCEPTION 'verification.evaluations is terminal-immutable in state % (evaluation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('evaluating', 'denied', 'concluded') THEN RAISE EXCEPTION 'verification evaluation % cannot move to status %', OLD.id, NEW.status; END IF; IF NEW.status = 'evaluating' AND NEW.ledger_requested_sequence = OLD.ledger_requested_sequence AND NEW.conclusion IS NOT DISTINCT FROM OLD.conclusion THEN RAISE EXCEPTION 'verification evaluation % UPDATE must change ledger sequence or finalize (no-op/status churn is not a legal update)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER evaluations_lifecycle_guard
    BEFORE UPDATE ON verification.evaluations
    FOR EACH ROW EXECUTE FUNCTION verification.evaluations_lifecycle();

-- ---------------------------------------------------------------------------
-- Verification results (owned by the verification module): the immutable
-- evidence records — the rich result model of the WORK-013 result-model
-- section. Every row answers WHO/WHAT/WHEN/WHY/WITH WHICH EVIDENCE.
-- ---------------------------------------------------------------------------

CREATE TABLE verification.results (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    evaluation_id uuid NOT NULL,
    target_kind   text NOT NULL,
    target_ref    text NOT NULL,
    target_revision text,
    criterion_id  text NOT NULL,
    criteria_version integer NOT NULL,
    evaluator_kind text NOT NULL,
    evaluator_id  text NOT NULL,
    evaluator_version text NOT NULL,
    status        text NOT NULL,
    confidence    numeric,
    observations  jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,
    policy_evidence jsonb,
    human_request_id uuid,
    recorded_by   text NOT NULL,
    recorded_at   timestamptz NOT NULL DEFAULT now(),
    -- THE verification-axis status vocabulary: provider-axis and
    -- tool-axis outcome classes are physically excluded.
    CONSTRAINT results_status_vocabulary CHECK (
        status IN ('PASS', 'FAIL', 'INCONCLUSIVE')
    ),
    CONSTRAINT results_evaluator_vocabulary CHECK (
        evaluator_kind IN ('deterministic', 'model', 'human')
    ),
    CONSTRAINT results_target_vocabulary CHECK (
        target_kind IN ('execution-output', 'plan-revision', 'artifact', 'tool-output', 'model-output', 'record', 'candidate')
    ),
    -- M4/M21: PASS requires non-empty evidence AND a criteria binding.
    CONSTRAINT results_pass_requires_evidence CHECK (
        status <> 'PASS' OR jsonb_array_length(evidence) >= 1
    ),
    CONSTRAINT results_pass_requires_criteria CHECK (
        status <> 'PASS' OR (length(criterion_id) BETWEEN 1 AND 200 AND criteria_version >= 1)
    ),
    -- M20: the evaluator identity AND version are always recorded.
    CONSTRAINT results_evaluator_identity_shape CHECK (
        length(evaluator_id) BETWEEN 1 AND 200
        AND length(evaluator_version) BETWEEN 1 AND 64
        AND length(recorded_by) BETWEEN 1 AND 200
    ),
    -- M24: a result is always bound to its evaluation journal evidence.
    CONSTRAINT results_provenance_bound CHECK (
        length(evaluation_id::text) = 36
    ),
    CONSTRAINT results_confidence_shape CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    CONSTRAINT results_observations_shape CHECK (jsonb_typeof(observations) = 'array'),
    CONSTRAINT results_evidence_shape CHECK (jsonb_typeof(evidence) = 'array'),
    CONSTRAINT results_criteria_shape CHECK (
        length(criterion_id) BETWEEN 1 AND 200 AND criteria_version >= 1
    ),
    CONSTRAINT results_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT results_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT results_evaluation_fk
        FOREIGN KEY (evaluation_id, application_id)
        REFERENCES verification.evaluations (id, application_id)
);

CREATE INDEX results_by_execution
    ON verification.results (application_id, execution_id, recorded_at);

CREATE INDEX results_by_criterion
    ON verification.results (application_id, execution_id, criterion_id, criteria_version);

-- M23: results are PHYSICALLY append-only — verification evidence is
-- immutable once recorded (no mutation after acceptance, ever).
CREATE OR REPLACE FUNCTION verification.results_no_mutation() RETURNS trigger AS $$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'verification.results rows are never deleted (result %)', OLD.id; ELSE RAISE EXCEPTION 'verification.results rows are immutable after recording (result %)', OLD.id; END IF; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER results_no_mutation_guard
    BEFORE UPDATE OR DELETE ON verification.results
    FOR EACH ROW EXECUTE FUNCTION verification.results_no_mutation();

-- ---------------------------------------------------------------------------
-- Human evaluation requests (owned by the verification module): the
-- mediated human/user evaluation path. Append-only except the
-- exactly-once answer finalization; the answered shape is pinned
-- (all-or-none) and the deciding actor identity is mandatory (M19).
-- ---------------------------------------------------------------------------

CREATE TABLE verification.human_evaluation_requests (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    request_key   text NOT NULL,
    request_fingerprint text NOT NULL,
    target_kind   text NOT NULL,
    target_ref    text NOT NULL,
    target_revision text,
    criterion_id  text NOT NULL,
    criteria_version integer NOT NULL,
    question      text NOT NULL,
    evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,
    requested_by  text NOT NULL,
    policy_evidence jsonb,
    requested_at  timestamptz NOT NULL DEFAULT now(),
    answered_by_result_id uuid,
    answered_by   text,
    answered_at   timestamptz,
    CONSTRAINT human_requests_target_vocabulary CHECK (
        target_kind IN ('execution-output', 'plan-revision', 'artifact', 'tool-output', 'model-output', 'record', 'candidate')
    ),
    CONSTRAINT human_requests_answered_shape CHECK (
        (answered_by_result_id IS NULL) = (answered_at IS NULL)
        AND (answered_by_result_id IS NULL) = (answered_by IS NULL)
    ),
    CONSTRAINT human_requests_identity_shape CHECK (
        length(request_key) BETWEEN 1 AND 200
        AND length(request_fingerprint) BETWEEN 1 AND 500
        AND length(question) BETWEEN 1 AND 2000
        AND length(requested_by) BETWEEN 1 AND 200
        AND (answered_by IS NULL OR length(answered_by) BETWEEN 1 AND 200)
    ),
    CONSTRAINT human_requests_criteria_shape CHECK (
        length(criterion_id) BETWEEN 1 AND 200 AND criteria_version >= 1
    ),
    CONSTRAINT human_requests_evidence_shape CHECK (jsonb_typeof(evidence) = 'array'),
    CONSTRAINT human_requests_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT human_requests_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT human_requests_request_key UNIQUE (application_id, request_key)
);

CREATE INDEX human_requests_by_execution
    ON verification.human_evaluation_requests (application_id, execution_id, requested_at);

CREATE OR REPLACE FUNCTION verification.human_requests_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'verification.human_evaluation_requests rows are never deleted (request %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER human_requests_no_delete_guard
    BEFORE DELETE ON verification.human_evaluation_requests
    FOR EACH ROW EXECUTE FUNCTION verification.human_requests_no_delete();

-- The ONLY legal UPDATE: answering an UNANSWERED request exactly once
-- (result binding + deciding actor identity + timestamp together).
CREATE OR REPLACE FUNCTION verification.human_requests_answer_once() RETURNS trigger AS $$ BEGIN IF OLD.answered_by_result_id IS NOT NULL THEN RAISE EXCEPTION 'verification.human_evaluation_requests % is already answered (exactly-once answer binding)', OLD.id; END IF; IF NEW.answered_by_result_id IS NULL OR NEW.answered_by IS NULL OR NEW.answered_at IS NULL THEN RAISE EXCEPTION 'verification.human_evaluation_requests % answer must set result binding, deciding actor and timestamp together', OLD.id; END IF; IF NEW.request_key <> OLD.request_key OR NEW.criterion_id <> OLD.criterion_id OR NEW.question <> OLD.question OR NEW.target_ref <> OLD.target_ref THEN RAISE EXCEPTION 'verification.human_evaluation_requests % answer must not mutate the request identity', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER human_requests_answer_once_guard
    BEFORE UPDATE ON verification.human_evaluation_requests
    FOR EACH ROW EXECUTE FUNCTION verification.human_requests_answer_once();

-- ---------------------------------------------------------------------------
-- Candidate comparisons (owned by the verification module): explicit,
-- planner-gated, criteria-bound comparison evidence with preserved
-- candidate identity. Append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE verification.comparisons (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    execution_id  uuid NOT NULL,
    comparison_key text NOT NULL,
    request_fingerprint text NOT NULL,
    criterion_id  text NOT NULL,
    criteria_version integer NOT NULL,
    candidates    jsonb NOT NULL,
    status        text NOT NULL,
    winner        text,
    per_candidate jsonb NOT NULL,
    rationale     jsonb NOT NULL DEFAULT '[]'::jsonb,
    evaluator_kind text NOT NULL,
    evaluator_id  text NOT NULL,
    evaluator_version text NOT NULL,
    planner_authorization jsonb NOT NULL,
    policy_evidence jsonb,
    compared_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT comparisons_status_vocabulary CHECK (
        status IN ('PASS', 'FAIL', 'INCONCLUSIVE')
    ),
    -- M16/M22: a winner exists IFF the criteria decided (PASS); an
    -- INCONCLUSIVE/FAIL comparison with a winner is unrepresentable.
    CONSTRAINT comparisons_winner_shape CHECK (
        (status = 'PASS') = (winner IS NOT NULL)
    ),
    CONSTRAINT comparisons_evaluator_vocabulary CHECK (
        evaluator_kind IN ('deterministic', 'model', 'human')
    ),
    CONSTRAINT comparisons_identity_shape CHECK (
        length(comparison_key) BETWEEN 1 AND 200
        AND length(request_fingerprint) BETWEEN 1 AND 500
        AND length(criterion_id) BETWEEN 1 AND 200
        AND (winner IS NULL OR length(winner) BETWEEN 1 AND 200)
    ),
    CONSTRAINT comparisons_candidates_shape CHECK (
        jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) >= 2
    ),
    CONSTRAINT comparisons_per_candidate_shape CHECK (
        jsonb_typeof(per_candidate) = 'array'
        AND jsonb_array_length(per_candidate) >= 2
    ),
    CONSTRAINT comparisons_planner_authorization_shape CHECK (
        jsonb_typeof(planner_authorization) = 'object'
        AND planner_authorization->>'initiator' = 'planner'
        AND length(COALESCE(planner_authorization->>'decisionRef', '')) >= 1
    ),
    CONSTRAINT comparisons_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT comparisons_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT comparisons_request_key UNIQUE (application_id, comparison_key)
);

CREATE OR REPLACE FUNCTION verification.comparisons_no_mutation() RETURNS trigger AS $$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'verification.comparisons rows are never deleted (comparison %)', OLD.id; ELSE RAISE EXCEPTION 'verification.comparisons rows are immutable after recording (comparison %)', OLD.id; END IF; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER comparisons_no_mutation_guard
    BEFORE UPDATE OR DELETE ON verification.comparisons
    FOR EACH ROW EXECUTE FUNCTION verification.comparisons_no_mutation();
