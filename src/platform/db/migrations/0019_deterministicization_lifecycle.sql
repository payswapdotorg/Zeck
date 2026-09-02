-- WORK-021 — Deterministicization discovery and progressive AI-call
-- elimination (DTR-001..DTR-004): the deterministicization lifecycle
-- axis.
--
-- The durable state of the runtime deterministicization lifecycle
-- (spec/deterministicization-contract.md + ADR-0008):
--   * learning.deterministicization_candidates — the immutable
--     PROPOSAL records (explicit replacement contract + program +
--     incumbent binding + MANDATORY provenance to source executions
--     and the evaluation corpus; content-derived identity; guarded
--     lifecycle status machine proposed -> validating -> validated ->
--     shadow -> canary -> promoted | rejected | deferred |
--     rolled-back);
--   * learning.deterministicization_stage_evidence — the WRITE-ONCE
--     validation-stage evidence (offline replay / differential
--     evaluation / property+metamorphic tests / mutation evidence;
--     one settled record per (candidate, stage); honest status
--     vocabulary passed/failed/insufficient);
--   * learning.deterministicization_rollouts — the shadow/canary
--     rollout phases with MEASURABLE cost/quality/latency deltas
--     (single-epoch per mode: observing -> concluded);
--   * learning.deterministicization_decisions — the APPEND-ONLY
--     decision journal (promoted / rejected / deferred / rolled-back;
--     every decision carries a non-empty rationale + the recorded gate
--     evaluation — DTR-004);
--   * learning.deterministicization_operations — the DURABLE,
--     RECOVERABLE OPERATION STATE (the PR #46 / WORK-024 crash-safety
--     discipline): one row per governed lifecycle operation with the
--     PENDING -> COMPLETED|FAILED machine, stable content-derived
--     operation keys, monotonic attempt counters and bounded stage
--     checkpoints. A crash between claim and completion leaves the
--     row PENDING; a retry re-begins the SAME key and the
--     content-derived row identities converge — exactly-once durable
--     side effects per stable key.
--
-- LEARNING IS OBSERVATIONAL (the frozen §10 invariant, preserved from
-- 0009/0010/0016/0017): no table here references policy, budget,
-- capability, execution, planner or sandbox STATE as a writable
-- target. The only cross-module references are READ-ONLY bindings:
--   * (application_id, tenant_id) -> applications.applications —
--     tenant identity is never dropped;
--   * (candidate_id, application_id) -> the candidates table —
--     evidence/rollout/decision rows point only at candidates of
--     THEIR OWN application.
-- The replacement program's EXECUTION happens through the tools
-- module's sandbox-executor seam (the sandbox admission chain stays
-- THE authority); this migration records lifecycle EVIDENCE and
-- DECISIONS only — there is no dispatch surface here, and no field of
-- any record can mutate execution identity (the incumbent binding is
-- a description, never a state write: DTR-003 "without changing
-- execution identity").
--
-- Physical invariants enforced here (violations are
-- UNREPRESENTABLE, not merely discouraged):
--   * candidates are WRITE-ONCE proposals: the identity core (ids,
--     class, subgraph anchor, provenance, recurrence, incumbent,
--     contract, program, proposer, timestamp) is immutable on every
--     UPDATE path; only the guarded status may move (single-step
--     forward only — the frozen transition table); terminal statuses
--     (rejected/rolled-back) are fully immutable (promoted is NOT —
--     its only legal move is the rollback path to rolled-back); rows
--     never deleted;
--   * provenance is PHYSICALLY MANDATORY: source_execution_ids and
--     evidence_refs are CHECK-bound non-empty jsonb arrays, the
--     corpus digest is CHECK-bound non-empty (a provenance-less
--     candidate is unrepresentable — the work order's implementation
--     requirement);
--   * a program is REQUIRED for every candidate class except
--     'removal' (CHECK-bound NULL-SAFE);
--   * stage evidence is IMMUTABLE and settles once: UNIQUE
--     (application, candidate, stage_kind) — a different record for a
--     settled stage is unrepresentable; the status vocabulary and the
--     differential-pairs-only-on-differential rule are CHECK-bound
--     (NULL-SAFE);
--   * rollouts: UNIQUE (application, candidate, mode) — one epoch per
--     phase; observing -> concluded is the only move (the identity
--     core + deltas are immutable after conclusion);
--   * the decision journal is APPEND-ONLY: decision_id PRIMARY KEY
--     converges retried requests; decision_seq (identity column)
--     orders the journal; kind is CHECK-bound to the vocabulary;
--     rationale is CHECK-bound non-empty (DTR-004); a promoted
--     decision must carry a promoting gate verdict, a rejected one a
--     fail-closed verdict, and only rollback decisions may record the
--     incumbent restoration target (all NULL-SAFE jsonb probes);
--   * the operations ledger follows the deployments.realtime_operations
--     discipline exactly: UNIQUE (application, operation_key)
--     arbitrates the durable claim; attempts is the monotonic retry
--     ledger; the checkpoint is bounded jsonb writable only while
--     PENDING; COMPLETED/FAILED are terminal-immutable and
--     completion-timestamped; rows are never deleted; candidate_id is
--     a PROVENANCE REFERENCE WITHOUT FK (an operation row is durably
--     claimed BEFORE its candidate row exists — that ordering is
--     exactly the crash window this ledger closes).
--
-- Migration-version discipline (the parallel-wave collision rule):
-- the live inventory at authoring time is 0001..0014, 0016, 0017 and
-- 0018 (0016_opportunity_analysis.sql, WORK-022; 0017 the
-- learned-policy migration, WORK-020; 0018_realtime_sessions.sql,
-- WORK-024). 0015 is BURNED — WORK-019's owned number, its file
-- absent from the tree (the documented wave-1 reconciliation
-- anomaly). THIS migration claims 0019 for WORK-021 (the sibling
-- WORK-025 of the current parallel wave claims 0020). No other
-- in-flight Work Order claims 0019.
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — trigger function bodies are single lines.

-- ---------------------------------------------------------------------------
-- The immutable deterministicization candidate proposals (learning-owned).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.deterministicization_candidates (
    id             text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    candidate_class text NOT NULL,
    status         text NOT NULL,
    subgraph       jsonb NOT NULL,
    provenance     jsonb NOT NULL,
    recurrence     jsonb NOT NULL,
    incumbent      jsonb NOT NULL,
    contract       jsonb NOT NULL,
    program_source text,
    program_digest text,
    program_language text,
    proposed_by    text NOT NULL,
    proposed_at    timestamptz NOT NULL,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    schema_version integer NOT NULL,
    -- The composite application binding the child FKs reference (the
    -- 0016/0017 discipline: evidence/rollout/decision rows point only
    -- at candidates of THEIR OWN application).
    CONSTRAINT dtr_candidates_id_application_unique UNIQUE (id, application_id),
    CONSTRAINT dtr_candidates_class_vocabulary CHECK (
        candidate_class IN ('removal','deterministic-replacement','hybrid-split','pipeline-replacement','tool-extraction')
    ),
    CONSTRAINT dtr_candidates_status_vocabulary CHECK (
        status IN ('proposed','validating','validated','shadow','canary','promoted','rejected','deferred','rolled-back')
    ),
    CONSTRAINT dtr_candidates_schema_version CHECK (schema_version >= 1),
    CONSTRAINT dtr_candidates_actor_nonempty CHECK (length(proposed_by) BETWEEN 1 AND 256),
    -- Provenance is PHYSICALLY MANDATORY (the implementation
    -- requirement: identity includes source executions + corpus).
    CONSTRAINT dtr_candidates_provenance_shape CHECK (
        jsonb_typeof(provenance) = 'object'
        AND jsonb_typeof(provenance->'sourceExecutionIds') = 'array'
        AND jsonb_array_length(provenance->'sourceExecutionIds') >= 1
        AND jsonb_typeof(provenance->'evidenceRefs') = 'array'
        AND jsonb_array_length(provenance->'evidenceRefs') >= 1
        AND length(COALESCE(provenance->>'corpusDigest', '')) BETWEEN 1 AND 128
        AND COALESCE((provenance->>'population')::int, 0) >= 1
    ),
    CONSTRAINT dtr_candidates_recurrence_shape CHECK (
        jsonb_typeof(recurrence) = 'object'
        AND COALESCE((recurrence->>'occurrenceCount')::int, 0) >= 1
        AND COALESCE(recurrence->>'totalCostMicroUsd', '') ~ '^[0-9]{1,19}$'
    ),
    CONSTRAINT dtr_candidates_subgraph_shape CHECK (
        jsonb_typeof(subgraph) = 'object'
        AND length(COALESCE(subgraph->>'subgraphId', '')) >= 1
        AND length(COALESCE(subgraph->>'taskClass', '')) >= 1
        AND length(COALESCE(subgraph->>'computationType', '')) >= 1
    ),
    CONSTRAINT dtr_candidates_incumbent_shape CHECK (
        jsonb_typeof(incumbent) = 'object'
        AND length(COALESCE(incumbent->>'strategyClass', '')) >= 1
        AND length(COALESCE(incumbent->>'descriptionDigest', '')) BETWEEN 1 AND 128
        AND length(COALESCE(incumbent->>'rollbackTarget', '')) >= 1
    ),
    CONSTRAINT dtr_candidates_contract_shape CHECK (
        jsonb_typeof(contract) = 'object'
        AND jsonb_typeof(contract->'acceptanceCriterion') = 'object'
        AND length(COALESCE(contract->'acceptanceCriterion'->>'description', '')) >= 1
    ),
    -- A program is REQUIRED for every class except removal (NULL-SAFE:
    -- the paired-digest check forces the presence).
    CONSTRAINT dtr_candidates_program_required CHECK (
        candidate_class = 'removal'
        OR (program_source IS NOT NULL AND length(program_digest) BETWEEN 1 AND 128)
    ),
    CONSTRAINT dtr_candidates_program_pair CHECK (
        (program_source IS NULL AND program_digest IS NULL AND program_language IS NULL)
        OR (program_source IS NOT NULL AND program_digest IS NOT NULL AND program_language = 'javascript-v1')
    ),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX dtr_candidates_scope_listing
    ON learning.deterministicization_candidates (application_id, tenant_id, proposed_at, id);

-- The identity core is write-once: ids, class, anchor, provenance,
-- recurrence, incumbent, contract, program and proposer never move
-- after creation; only the guarded status/updated_at may.
CREATE OR REPLACE FUNCTION learning.dtr_candidates_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.candidate_class <> OLD.candidate_class OR NEW.subgraph <> OLD.subgraph OR NEW.provenance <> OLD.provenance OR NEW.recurrence <> OLD.recurrence OR NEW.incumbent <> OLD.incumbent OR NEW.contract <> OLD.contract OR NEW.program_source IS DISTINCT FROM OLD.program_source OR NEW.program_digest IS DISTINCT FROM OLD.program_digest OR NEW.program_language IS DISTINCT FROM OLD.program_language OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at OR NEW.created_at <> OLD.created_at OR NEW.schema_version <> OLD.schema_version THEN RAISE EXCEPTION 'learning.deterministicization_candidates identity core is immutable (candidate % — provenance, contract and program never move)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_candidates_core_guard
    BEFORE UPDATE ON learning.deterministicization_candidates
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_candidates_core_immutable();

-- The frozen candidate status machine (single-step forward only; the
-- same transition table as the domain; promoted -> rolled-back is the
-- rollback path; rejected and rolled-back are terminal (re-validation
-- after a rollback is a NEW candidate — the rollout phases are
-- single-epoch per candidate); deferred re-enters validating). NOTE:
-- 'promoted' is NOT terminal — the rollback path moves it forward to
-- 'rolled-back' (the transition table below is the guard; only
-- 'rejected'/'rolled-back' are fully immutable).
CREATE OR REPLACE FUNCTION learning.dtr_candidates_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('rejected','rolled-back') AND OLD.status <> NEW.status THEN RAISE EXCEPTION 'learning.deterministicization_candidates is terminal-immutable in status % (candidate %)', OLD.status, OLD.id; END IF; IF NOT ((NEW.status = OLD.status) OR (OLD.status = 'proposed' AND NEW.status IN ('validating','rejected','deferred')) OR (OLD.status = 'validating' AND NEW.status IN ('validating','validated','rejected','deferred')) OR (OLD.status = 'validated' AND NEW.status IN ('shadow','rejected','deferred')) OR (OLD.status = 'shadow' AND NEW.status IN ('canary','rejected','deferred')) OR (OLD.status = 'canary' AND NEW.status IN ('promoted','rejected','deferred')) OR (OLD.status = 'promoted' AND NEW.status = 'rolled-back') OR (OLD.status = 'deferred' AND NEW.status IN ('validating','rejected'))) THEN RAISE EXCEPTION 'deterministicization candidate % cannot move from status % to % (single-step forward only)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_candidates_lifecycle_guard
    BEFORE UPDATE ON learning.deterministicization_candidates
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_candidates_lifecycle();

CREATE OR REPLACE FUNCTION learning.dtr_candidates_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.deterministicization_candidates rows are never deleted (candidate %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_candidates_no_delete_guard
    BEFORE DELETE ON learning.deterministicization_candidates
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_candidates_no_delete();

-- ---------------------------------------------------------------------------
-- The write-once validation-stage evidence (DTR-002).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.deterministicization_stage_evidence (
    evidence_id    text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    candidate_id   text NOT NULL,
    stage_kind     text NOT NULL,
    status         text NOT NULL,
    basis          jsonb NOT NULL,
    runs           jsonb NOT NULL,
    pairs          jsonb NOT NULL DEFAULT '[]'::jsonb,
    metrics        jsonb NOT NULL,
    criterion_digest text NOT NULL,
    evidence_refs  jsonb NOT NULL,
    recorded_at    timestamptz NOT NULL,
    recorded_by    text NOT NULL,
    schema_version integer NOT NULL,
    CONSTRAINT dtr_evidence_stage_vocabulary CHECK (
        stage_kind IN ('offline-replay','differential-evaluation','property-tests','mutation-tests')
    ),
    CONSTRAINT dtr_evidence_status_vocabulary CHECK (
        status IN ('passed','failed','insufficient')
    ),
    CONSTRAINT dtr_evidence_schema_version CHECK (schema_version >= 1),
    CONSTRAINT dtr_evidence_actor_nonempty CHECK (length(recorded_by) BETWEEN 1 AND 256),
    CONSTRAINT dtr_evidence_criterion_nonempty CHECK (length(criterion_digest) BETWEEN 1 AND 128),
    -- The corpus basis is MANDATORY (revision-bound evidence).
    CONSTRAINT dtr_evidence_basis_shape CHECK (
        jsonb_typeof(basis) = 'object'
        AND length(COALESCE(basis->>'corpusDigest', '')) BETWEEN 1 AND 128
        AND jsonb_typeof(basis->'sourceExecutionIds') = 'array'
        AND jsonb_array_length(basis->'sourceExecutionIds') >= 1
        AND COALESCE((basis->>'population')::int, 0) >= 1
    ),
    -- Runs are non-empty UNLESS the honest status is 'insufficient'
    -- (no evidence is recorded as no evidence — never fabricated).
    CONSTRAINT dtr_evidence_runs_shape CHECK (
        jsonb_typeof(runs) = 'array'
        AND (status = 'insufficient' OR jsonb_array_length(runs) >= 1)
    ),
    -- Differential pairs ONLY on the differential stage, REQUIRED
    -- there (NULL-SAFE probes).
    CONSTRAINT dtr_evidence_pairs_shape CHECK (
        jsonb_typeof(pairs) = 'array'
        AND (
            (stage_kind = 'differential-evaluation' AND (status = 'insufficient' OR jsonb_array_length(pairs) >= 1))
            OR (stage_kind <> 'differential-evaluation' AND jsonb_array_length(pairs) = 0)
        )
    ),
    CONSTRAINT dtr_evidence_metrics_shape CHECK (
        jsonb_typeof(metrics) = 'object'
        AND COALESCE((metrics->>'population')::int, 0) >= 0
    ),
    CONSTRAINT dtr_evidence_refs_shape CHECK (
        jsonb_typeof(evidence_refs) = 'array'
        AND jsonb_array_length(evidence_refs) >= 1
    ),
    -- The stage settles ONCE: a different record for a settled stage
    -- is unrepresentable (a different basis is a different candidate).
    CONSTRAINT dtr_evidence_stage_slot_unique UNIQUE (application_id, candidate_id, stage_kind),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- Evidence can only point at a candidate of ITS OWN application.
    FOREIGN KEY (candidate_id, application_id)
        REFERENCES learning.deterministicization_candidates (id, application_id)
);

CREATE INDEX dtr_evidence_scope_listing
    ON learning.deterministicization_stage_evidence (application_id, tenant_id, candidate_id, recorded_at);

-- Evidence rows are immutable (append-only; retries converge on the
-- PRIMARY KEY, the stage slot guard rejects different-basis rewrites).
CREATE OR REPLACE FUNCTION learning.dtr_evidence_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.deterministicization_stage_evidence rows are immutable (evidence %)', OLD.evidence_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_evidence_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.deterministicization_stage_evidence
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_evidence_immutable();

-- ---------------------------------------------------------------------------
-- The shadow/canary rollout phases with measurable deltas (DTR-003).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.deterministicization_rollouts (
    rollout_id     text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    candidate_id   text NOT NULL,
    mode           text NOT NULL,
    status         text NOT NULL,
    population     integer NOT NULL DEFAULT 0,
    matched_count  integer NOT NULL DEFAULT 0,
    cost_delta_micro_usd text NOT NULL DEFAULT '0',
    quality_delta  double precision NOT NULL DEFAULT 0,
    latency_delta_ms integer NOT NULL DEFAULT 0,
    evidence_refs  jsonb NOT NULL DEFAULT '[]'::jsonb,
    began_at       timestamptz NOT NULL,
    concluded_at   timestamptz,
    schema_version integer NOT NULL,
    CONSTRAINT dtr_rollouts_mode_vocabulary CHECK (mode IN ('shadow','canary')),
    CONSTRAINT dtr_rollouts_status_vocabulary CHECK (status IN ('observing','concluded')),
    CONSTRAINT dtr_rollouts_schema_version CHECK (schema_version >= 1),
    CONSTRAINT dtr_rollouts_population_nonnegative CHECK (population >= 0),
    CONSTRAINT dtr_rollouts_matched_bounds CHECK (matched_count >= 0 AND matched_count <= population),
    CONSTRAINT dtr_rollouts_cost_shape CHECK (cost_delta_micro_usd ~ '^[0-9]{1,19}$'),
    CONSTRAINT dtr_rollouts_quality_bounds CHECK (quality_delta >= 0 AND quality_delta <= 1),
    CONSTRAINT dtr_rollouts_concluded_populated CHECK (
        status <> 'concluded' OR (population >= 1 AND concluded_at IS NOT NULL)
    ),
    CONSTRAINT dtr_rollouts_observing_unconcluded CHECK (
        status <> 'observing' OR concluded_at IS NULL
    ),
    -- One epoch per phase: the (application, candidate, mode) slot is
    -- settled once (the stage-evidence discipline).
    CONSTRAINT dtr_rollouts_mode_slot_unique UNIQUE (application_id, candidate_id, mode),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (candidate_id, application_id)
        REFERENCES learning.deterministicization_candidates (id, application_id)
);

CREATE INDEX dtr_rollouts_scope_listing
    ON learning.deterministicization_rollouts (application_id, tenant_id, candidate_id, began_at);

-- The identity core is write-once; observing -> concluded is the only
-- status move (first writer wins — a duplicate conclusion converges on
-- the committed row); a concluded rollout is FULLY immutable (its
-- measurable deltas — the DTR-003 evidence — never move after
-- conclusion).
CREATE OR REPLACE FUNCTION learning.dtr_rollouts_lifecycle() RETURNS trigger AS $$ BEGIN IF NEW.rollout_id <> OLD.rollout_id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.candidate_id <> OLD.candidate_id OR NEW.mode <> OLD.mode OR NEW.began_at <> OLD.began_at OR NEW.schema_version <> OLD.schema_version THEN RAISE EXCEPTION 'learning.deterministicization_rollouts identity core is immutable (rollout %)', OLD.rollout_id; END IF; IF OLD.status = 'concluded' AND (NEW.status <> 'concluded' OR NEW.population <> OLD.population OR NEW.matched_count <> OLD.matched_count OR NEW.cost_delta_micro_usd <> OLD.cost_delta_micro_usd OR NEW.quality_delta <> OLD.quality_delta OR NEW.latency_delta_ms <> OLD.latency_delta_ms OR NEW.evidence_refs <> OLD.evidence_refs OR NEW.concluded_at <> OLD.concluded_at) THEN RAISE EXCEPTION 'a concluded rollout is terminal-immutable (rollout %)', OLD.rollout_id; END IF; IF NOT (NEW.status = OLD.status OR (OLD.status = 'observing' AND NEW.status = 'concluded')) THEN RAISE EXCEPTION 'rollout % cannot move from status % to % (observing -> concluded only)', OLD.rollout_id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_rollouts_lifecycle_guard
    BEFORE UPDATE ON learning.deterministicization_rollouts
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_rollouts_lifecycle();

CREATE OR REPLACE FUNCTION learning.dtr_rollouts_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.deterministicization_rollouts rows are never deleted (rollout %)', OLD.rollout_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_rollouts_no_delete_guard
    BEFORE DELETE ON learning.deterministicization_rollouts
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_rollouts_no_delete();

-- ---------------------------------------------------------------------------
-- The append-only decision journal (DTR-004: every decision carries
-- its rationale + the recorded gate evaluation).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.deterministicization_decisions (
    decision_id    text PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    candidate_id   text NOT NULL,
    decision_kind  text NOT NULL,
    rationale      text NOT NULL,
    gate           jsonb NOT NULL,
    incumbent_restored_to text,
    decided_by     text NOT NULL,
    decided_at     timestamptz NOT NULL,
    schema_version integer NOT NULL,
    decision_seq   bigint GENERATED ALWAYS AS IDENTITY,
    CONSTRAINT dtr_decisions_kind_vocabulary CHECK (
        decision_kind IN ('promoted','rejected','deferred','rolled-back')
    ),
    CONSTRAINT dtr_decisions_schema_version CHECK (schema_version >= 1),
    CONSTRAINT dtr_decisions_rationale_nonempty CHECK (length(rationale) BETWEEN 1 AND 4096),
    CONSTRAINT dtr_decisions_actor_nonempty CHECK (length(decided_by) BETWEEN 1 AND 256),
    -- The recorded gate evaluation (revision-bound: verdict + config
    -- digest + evidence bindings; NULL-SAFE probes).
    CONSTRAINT dtr_decisions_gate_shape CHECK (
        jsonb_typeof(gate) = 'object'
        AND COALESCE(gate->>'verdict', '') IN ('promote','not-promoted')
        AND length(COALESCE(gate->>'gateConfigDigest', '')) BETWEEN 1 AND 128
        AND jsonb_typeof(gate->'reasons') = 'array'
        AND jsonb_typeof(gate->'stageEvidenceIds') = 'array'
        AND jsonb_typeof(gate->'rolloutIds') = 'array'
    ),
    -- Kind/verdict agreement: promotion requires a promoting gate,
    -- rejection records a fail-closed gate (NULL-SAFE).
    CONSTRAINT dtr_decisions_kind_verdict_agreement CHECK (
        (decision_kind <> 'promoted' OR COALESCE(gate->>'verdict', '') = 'promote')
        AND (decision_kind <> 'rejected' OR COALESCE(gate->>'verdict', '') = 'not-promoted')
    ),
    CONSTRAINT dtr_decisions_promoting_gate_no_reasons CHECK (
        COALESCE(gate->>'verdict', '') <> 'promote' OR jsonb_array_length(gate->'reasons') = 0
    ),
    CONSTRAINT dtr_decisions_failing_gate_lists_reasons CHECK (
        COALESCE(gate->>'verdict', '') <> 'not-promoted' OR jsonb_array_length(gate->'reasons') >= 1
    ),
    -- Only rollback decisions record the incumbent restoration target.
    CONSTRAINT dtr_decisions_restoration_rollback_only CHECK (
        (decision_kind = 'rolled-back' AND length(COALESCE(incumbent_restored_to, '')) >= 1)
        OR (decision_kind <> 'rolled-back' AND incumbent_restored_to IS NULL)
    ),
    -- Journal order is the serialization: unique sequence; the same
    -- logical decision retries converge on the PRIMARY KEY.
    CONSTRAINT dtr_decisions_seq_unique UNIQUE (decision_seq),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    FOREIGN KEY (candidate_id, application_id)
        REFERENCES learning.deterministicization_candidates (id, application_id)
);

CREATE INDEX dtr_decisions_scope_listing
    ON learning.deterministicization_decisions (application_id, tenant_id, candidate_id, decided_at);

-- The journal is append-only evidence (decision history is never
-- rewritten — rollback appends a 'rolled-back' entry).
CREATE OR REPLACE FUNCTION learning.dtr_decisions_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.deterministicization_decisions rows are immutable (decision %)', OLD.decision_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_decisions_immutable_guard
    BEFORE UPDATE OR DELETE ON learning.deterministicization_decisions
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_decisions_immutable();

-- ---------------------------------------------------------------------------
-- The durable, recoverable deterministicization OPERATION state (the
-- WORK-024 crash-safety discipline). One row per governed lifecycle
-- operation: PENDING (claimed, not durably complete — a crash in the
-- claim/completion window leaves this; a retry MUST resume with the
-- STABLE operation key) -> COMPLETED (the durable outcome exists;
-- replays return it with no side effect) | FAILED (a durably recorded
-- terminal failure outcome).
-- ---------------------------------------------------------------------------

CREATE TABLE learning.deterministicization_operations (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    -- Provenance reference WITHOUT FK by design: an operation row is
    -- durably claimed BEFORE its candidate row exists (that ordering
    -- is exactly the crash window this ledger closes).
    candidate_id   text,
    operation_kind text NOT NULL,
    operation_key  text NOT NULL,
    status         text NOT NULL,
    attempts       integer NOT NULL DEFAULT 1,
    -- Bounded stage checkpoint (the resume facts; never payloads).
    checkpoint     jsonb,
    failure_reason text,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    completed_at   timestamptz,
    CONSTRAINT dtr_ops_kind_vocabulary CHECK (
        operation_kind IN ('candidate-registration','stage-evidence','shadow-rollout','canary-rollout','promotion','rollback')
    ),
    CONSTRAINT dtr_ops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT dtr_ops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT dtr_ops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT dtr_ops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT dtr_ops_checkpoint_bounded CHECK (checkpoint IS NULL OR pg_column_size(checkpoint) <= 4096),
    CONSTRAINT dtr_ops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT dtr_ops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT dtr_ops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT dtr_ops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT dtr_ops_key_unique UNIQUE (application_id, operation_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX dtr_ops_candidate_listing
    ON learning.deterministicization_operations (application_id, candidate_id, created_at);

CREATE INDEX dtr_ops_pending_scan
    ON learning.deterministicization_operations (application_id, status, updated_at)
    WHERE status = 'pending';

-- The identity core is write-once: application/tenant binding, the
-- candidate provenance reference, the operation kind and key, and the
-- creation timestamp never move.
CREATE OR REPLACE FUNCTION learning.dtr_ops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'learning.deterministicization_operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_ops_core_guard
    BEFORE UPDATE ON learning.deterministicization_operations
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_ops_core_immutable();

-- The recoverable status machine: only PENDING may move (to COMPLETED
-- or FAILED, with the outcome fields set atomically); COMPLETED/FAILED
-- are terminal-immutable; attempts never regress. A checkpoint write
-- on a terminal row is tolerated as a converged no-op by the adapter
-- (the guard keeps the committed outcome frozen).
CREATE OR REPLACE FUNCTION learning.dtr_ops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') AND (NEW.status <> OLD.status OR NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason OR NEW.checkpoint IS DISTINCT FROM OLD.checkpoint) THEN RAISE EXCEPTION 'learning.deterministicization_operations is terminal-immutable in status % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) THEN RAISE EXCEPTION 'deterministicization operation % cannot move from status % to % (pending -> completed|failed only; terminal states frozen)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_ops_lifecycle_guard
    BEFORE UPDATE ON learning.deterministicization_operations
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_ops_lifecycle();

CREATE OR REPLACE FUNCTION learning.dtr_ops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'learning.deterministicization_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dtr_ops_no_delete_guard
    BEFORE DELETE ON learning.deterministicization_operations
    FOR EACH ROW EXECUTE FUNCTION learning.dtr_ops_no_delete();
