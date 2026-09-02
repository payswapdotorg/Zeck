-- WORK-026 — Media Generation Agent Deployment (MOD-011/012/013).
--
-- The durable state of the media-generation fabric: MEDIA JOBS bound
-- to tenant + application + deployment + PINNED deployment plan
-- version + Execution identity with the CLOSED provider-neutral job
-- lifecycle (MOD-011: submitted -> dispatching -> generating ->
-- verifying -> completed|failed|cancelled; provider states are
-- NORMALIZED into the closed observation vocabulary at the rail
-- adapter — a raw provider state string is never a job status), the
-- APPEND-ONLY provider-observation ledger whose rows ARE the
-- observation idempotency ledger for duplicate polls/callbacks (MOD-
-- 013), the immutable ARTIFACT-ADOPTION records linking generated
-- outputs and derived variants to the canonical content-addressed
-- artifact authority's digests + lineage + deployment version
-- (MOD-012), and the DURABLE, RECOVERABLE OPERATION STATE (the
-- WORK-024 crash-safety standard).
--
-- AUTHORITY PRESERVATION (the frozen invariants + the WORK-026 work
-- order):
--   * a media job IS a governed Execution (never a second job
--     abstraction with independent authority): execution_id is a
--     REFERENCE (uuid, no FK into executions state) — the job never
--     writes execution status directly; execution status moves ONLY
--     through the executions public transition-command surface
--     (verify/pass/fail/cancel) driven by the deployments media
--     ledger adapter; the canonical submission/dispatch/observation/
--     verification/artifact/cancellation/completion provenance rides
--     the executions EventEnvelope ledger through the executions
--     public recordStepEvent seam (executions vocabulary
--     "agent-session-started" / "agent-action-recorded" /
--     "agent-session-completed"); this job ledger records job state
--     + idempotency + observation evidence + the ledger-sequence
--     linkage (ledger_sequence), never a second event authority;
--   * GENERATED MEDIA is persisted through the canonical ARTIFACT
--     authority: media_jobs.output_artifact_digest and
--     media_artifacts.artifact_digest are 64-hex CONTENT-ADDRESSED
--     references to artifacts owned by the artifacts module (its own
--     put-if-absent immutable substrate — the deployments module
--     never stores media bytes and never mutates artifact identity);
--     the media_artifacts rows are the ADOPTION LEDGER (job ↔
--     artifact ↔ lineage ↔ deployment version linkage), not the
--     artifact store; large media never embeds in job rows or
--     EventEnvelope payloads (bounded descriptors + digest
--     references only);
--   * the provider rail is replaceable infrastructure: provider_job_ref
--     is the rail's OPAQUE reference (evidence only — never the
--     primary identity; the Zeck-side stable identity is
--     submission_key + the job row id); provider_state_label is the
--     rail's RAW state label recorded as reference-only evidence —
--     the job status vocabulary is the CLOSED neutral lifecycle
--     (CHECK constraint), never a provider vocabulary;
--   * the paid dispatch is budget-before-dispatch by structure: the
--     dispatching status records reservation_id (the budgets
--     authority's reservation identity — evidence; the budgets
--     module remains authoritative) and only the service layer that
--     reserved moves a job into dispatching; the unique (application,
--     operation_key) on media_operations arbitrates exactly-one paid
--     dispatch per job (operation key mediaop:paid-dispatch:<jobId>);
--   * tenant scope is never dropped: every table carries (application_id,
--     tenant_id) with the composite FK to applications.applications.
--
-- PHYSICAL INVARIANT SUMMARY:
--   * media_jobs: the identity core (application/tenant/deployment,
--     pinned plan id+version, execution id, generation kind,
--     submission key, creation fingerprint, created_by, created_at,
--     verification mode+criteria, preprocessing digest,
--     input artifact digest, retry-of) is immutable on every UPDATE
--     path; only the guarded lifecycle fields may move and ONLY
--     through the frozen transition vocabulary (trigger); terminal
--     statuses (completed/failed/cancelled) are fully immutable;
--     rows are never deleted; UNIQUE (application_id,
--     submission_key) arbitrates duplicate submissions; UNIQUE
--     (application_id, id) is the primary key;
--   * media_observations: APPEND-ONLY (no UPDATE/DELETE); UNIQUE
--     (application_id, job_id, observation_key) arbitrates duplicate
--     polls/callbacks; the closed normalized observation vocabulary
--     (CHECK); the observation body digest arbitrates same-key/
--     different-body replays (fail closed, service + digest check);
--     output descriptors are bounded jsonb (never media bytes);
--   * media_artifacts: write-once immutable adoption records; UNIQUE
--     (application_id, artifact_key) arbitrates idempotent adoption
--     retries; artifact digests are 64-hex content-addressed
--     references (CHECK); parent digests are bounded reference
--     arrays (lineage linkage — the artifact authority owns the
--     lineage semantics; these rows link them to the job/deployment);
--   * media_operations (the WORK-024 crash-safety standard): the
--     DURABLE, RECOVERABLE OPERATION STATE — one row per governed
--     media side-effect operation with the PENDING ->
--     COMPLETED|FAILED machine. UNIQUE (application_id, operation_key)
--     arbitrates the durable claim; `attempts` is the retry ledger
--     (monotonic); the checkpoint is bounded jsonb and writable only
--     while PENDING; COMPLETED/FAILED are fully immutable and
--     completion-timestamped; rows are never deleted. job_id is a
--     PROVENANCE REFERENCE WITHOUT FK — a job-submission operation
--     row is durably claimed BEFORE its job row exists (that
--     ordering is exactly the crash window this ledger closes).
--
-- Migration-version discipline (the collision rule, parallel wave):
-- the live inventory at authoring time is 0001..0014, 0016, 0017,
-- 0018, 0019 and 0020 (0016_opportunity_analysis.sql, WORK-022;
-- 0017_learned_planning_policies.sql, WORK-020; 0018_realtime_
-- sessions.sql, WORK-024; 0019_deterministicization_lifecycle.sql,
-- WORK-021; 0020_messaging_conversations.sql, WORK-025). 0015 is
-- BURNED (WORK-019's owned number; its file is absent from the tree
-- by the documented wave-1 reconciliation anomaly — never reused).
-- The wave-4 pre-assigned numbers by dispatch order: WORK-026 claims
-- 0021 (THIS migration), sibling WORK-028 claims 0022 (its file is
-- NOT in this branch). No other unmerged Work Order claims 0021.

CREATE TABLE deployments.media_jobs (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    deployment_id  uuid NOT NULL,
    pinned_plan_id text NOT NULL,
    pinned_plan_version integer NOT NULL,
    execution_id   uuid NOT NULL,
    generation_kind text NOT NULL,
    status         text NOT NULL,
    submission_key text NOT NULL,
    creation_fingerprint text NOT NULL,
    provider_job_ref text,
    provider_state_label text,
    verification_mode text NOT NULL,
    verification_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
    reservation_id text,
    preprocessing_digest text,
    postprocessing_digest text,
    output_artifact_digest text,
    input_artifact_digest text,
    retry_of_job_id uuid,
    failure_cause  text,
    created_by     uuid NOT NULL,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    completed_at   timestamptz,
    CONSTRAINT media_jobs_kind_vocabulary CHECK (generation_kind IN ('video','image','audio','multimodal')),
    CONSTRAINT media_jobs_status_vocabulary CHECK (status IN ('submitted','dispatching','generating','verifying','completed','failed','cancelled')),
    CONSTRAINT media_jobs_verification_mode CHECK (verification_mode IN ('none','required')),
    CONSTRAINT media_jobs_lifecycle CHECK (
        (status IN ('completed','failed','cancelled') AND completed_at IS NOT NULL)
        OR (status NOT IN ('completed','failed','cancelled') AND completed_at IS NULL)),
    CONSTRAINT media_jobs_failed_has_cause CHECK (status <> 'failed' OR failure_cause IS NOT NULL),
    CONSTRAINT media_jobs_terminal_no_cause CHECK (status NOT IN ('completed','cancelled') OR failure_cause IS NULL),
    CONSTRAINT media_jobs_plan_version_positive CHECK (pinned_plan_version >= 1),
    CONSTRAINT media_jobs_fingerprint_nonempty CHECK (length(creation_fingerprint) BETWEEN 1 AND 4096),
    CONSTRAINT media_jobs_key_nonempty CHECK (length(submission_key) BETWEEN 1 AND 200),
    CONSTRAINT media_jobs_provider_ref_bounded CHECK (provider_job_ref IS NULL OR length(provider_job_ref) BETWEEN 1 AND 200),
    CONSTRAINT media_jobs_provider_label_bounded CHECK (provider_state_label IS NULL OR length(provider_state_label) <= 200),
    CONSTRAINT media_jobs_failure_bounded CHECK (failure_cause IS NULL OR length(failure_cause) <= 2000),
    CONSTRAINT media_jobs_preprocessing_digest CHECK (preprocessing_digest IS NULL OR preprocessing_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_jobs_postprocessing_digest CHECK (postprocessing_digest IS NULL OR postprocessing_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_jobs_output_digest CHECK (output_artifact_digest IS NULL OR output_artifact_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_jobs_input_digest CHECK (input_artifact_digest IS NULL OR input_artifact_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_jobs_criteria_bounded CHECK (pg_column_size(verification_criteria) <= 2048 AND jsonb_array_length(verification_criteria) <= 8),
    CONSTRAINT media_jobs_verification_shape CHECK (
        (verification_mode = 'required' AND jsonb_array_length(verification_criteria) >= 1)
        OR (verification_mode = 'none' AND verification_criteria = '[]'::jsonb)),
    CONSTRAINT media_jobs_reservation_bounded CHECK (reservation_id IS NULL OR length(reservation_id) <= 128),
    CONSTRAINT media_jobs_completed_has_output CHECK (status <> 'completed' OR output_artifact_digest IS NOT NULL),
    CONSTRAINT media_jobs_submission_key_unique UNIQUE (application_id, submission_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT media_jobs_deployment_fk FOREIGN KEY (deployment_id)
        REFERENCES deployments.deployments (id)
);

CREATE INDEX media_jobs_scope_listing
    ON deployments.media_jobs (application_id, deployment_id, created_at, id);

CREATE INDEX media_jobs_execution_link
    ON deployments.media_jobs (application_id, execution_id);

CREATE INDEX media_jobs_pending_scan
    ON deployments.media_jobs (application_id, status, updated_at)
    WHERE status IN ('submitted','dispatching','verifying');

-- The identity core is write-once: tenant/deployment binding, the
-- PINNED plan version (version pinning — promotion/rollback move the
-- deployment pointer for NEW jobs only), the Execution identity
-- binding (one job = one execution = one paid dispatch), the
-- generation kind, the submission key, the creation fingerprint, the
-- declared verification policy, the deterministic preprocessing
-- digest, the lineage root and the retry linkage never move after
-- creation.
CREATE OR REPLACE FUNCTION deployments.media_jobs_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.pinned_plan_id <> OLD.pinned_plan_id OR NEW.pinned_plan_version <> OLD.pinned_plan_version OR NEW.execution_id <> OLD.execution_id OR NEW.generation_kind <> OLD.generation_kind OR NEW.submission_key <> OLD.submission_key OR NEW.creation_fingerprint <> OLD.creation_fingerprint OR NEW.verification_mode <> OLD.verification_mode OR NEW.verification_criteria IS DISTINCT FROM OLD.verification_criteria OR NEW.preprocessing_digest IS DISTINCT FROM OLD.preprocessing_digest OR NEW.input_artifact_digest IS DISTINCT FROM OLD.input_artifact_digest OR NEW.retry_of_job_id IS DISTINCT FROM OLD.retry_of_job_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.media_jobs identity core is immutable (job % — the pinned plan version, execution identity, generation kind and verification policy never move)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_jobs_core_guard
    BEFORE UPDATE ON deployments.media_jobs
    FOR EACH ROW EXECUTE FUNCTION deployments.media_jobs_core_immutable();

-- The frozen media job lifecycle (the CLOSED provider-neutral
-- vocabulary; terminal statuses fully immutable; provider states are
-- normalized observations, never statuses).
CREATE OR REPLACE FUNCTION deployments.media_jobs_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'deployments.media_jobs is terminal-immutable in state % (job %)', OLD.status, OLD.id; END IF; IF NOT ( (OLD.status = 'submitted' AND NEW.status IN ('dispatching','cancelled')) OR (OLD.status = 'dispatching' AND NEW.status IN ('generating','failed','cancelled')) OR (OLD.status = 'generating' AND NEW.status IN ('verifying','failed','cancelled')) OR (OLD.status = 'verifying' AND NEW.status IN ('completed','failed')) ) THEN RAISE EXCEPTION 'media job % cannot move from status % to % (the closed provider-neutral lifecycle)', OLD.id, OLD.status, NEW.status; END IF; IF OLD.status = 'dispatching' AND NEW.status = 'generating' AND (NEW.provider_job_ref IS NULL OR OLD.provider_job_ref IS NOT NULL) THEN RAISE EXCEPTION 'media job % must record the rail''s opaque job reference exactly once when it reaches generating', NEW.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_jobs_lifecycle_guard
    BEFORE UPDATE ON deployments.media_jobs
    FOR EACH ROW EXECUTE FUNCTION deployments.media_jobs_lifecycle();

-- Output artifacts are only recorded on completed jobs (the
-- verification-before-completion projection: an output digest can
-- never appear while a job is non-terminal or failed).
CREATE OR REPLACE FUNCTION deployments.media_jobs_output_projection() RETURNS trigger AS $$ BEGIN IF NEW.output_artifact_digest IS NOT NULL AND NEW.status <> 'completed' THEN RAISE EXCEPTION 'media job % cannot carry an output artifact digest in status % (outputs attach only at completion — the verification-before-completion projection)', NEW.id, NEW.status; END IF; IF NEW.postprocessing_digest IS NOT NULL AND NEW.status NOT IN ('verifying','completed') THEN RAISE EXCEPTION 'media job % cannot carry a postprocessing digest in status % (the deterministic postprocessing precedes completion only)', NEW.id, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_jobs_output_projection_guard
    BEFORE UPDATE ON deployments.media_jobs
    FOR EACH ROW EXECUTE FUNCTION deployments.media_jobs_output_projection();

CREATE OR REPLACE FUNCTION deployments.media_jobs_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.media_jobs rows are never deleted (job %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_jobs_no_delete_guard
    BEFORE DELETE ON deployments.media_jobs
    FOR EACH ROW EXECUTE FUNCTION deployments.media_jobs_no_delete();

-- Verification criteria are 1..8 declared criteria references (the
-- verification authority's declaration identities — never criteria
-- bodies, never secrets).
CREATE OR REPLACE FUNCTION deployments.media_jobs_criteria_shape() RETURNS trigger AS $$ DECLARE element jsonb; count integer := 0; BEGIN IF NEW.verification_criteria IS NULL THEN RETURN NEW; END IF; IF jsonb_typeof(NEW.verification_criteria) <> 'array' THEN RAISE EXCEPTION 'media job verification criteria must be a jsonb array (job %)', NEW.id; END IF; FOR element IN SELECT jsonb_array_elements(NEW.verification_criteria) LOOP count := count + 1; IF jsonb_typeof(element) <> 'object' THEN RAISE EXCEPTION 'media job verification criteria entries must be objects (job %)', NEW.id; END IF; IF element ? 'criterionId' = false OR element ? 'version' = false THEN RAISE EXCEPTION 'media job verification criteria entries must carry criterionId and version (job %)', NEW.id; END IF; IF jsonb_typeof(element->'criterionId') <> 'string' OR length(element->>'criterionId') < 1 OR length(element->>'criterionId') > 128 THEN RAISE EXCEPTION 'media job verification criterionId must be 1..128 chars (job %)', NEW.id; END IF; IF jsonb_typeof(element->'version') <> 'number' OR (element->>'version') !~ '^[0-9]+$' OR (element->>'version')::integer < 1 THEN RAISE EXCEPTION 'media job verification criterion version must be a positive integer (job %)', NEW.id; END IF; END LOOP; IF NEW.verification_mode = 'required' AND count < 1 THEN RAISE EXCEPTION 'media job % requires at least one declared verification criterion', NEW.id; END IF; IF NEW.verification_mode = 'none' AND count > 0 THEN RAISE EXCEPTION 'media job % in verification mode none cannot carry criteria', NEW.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_jobs_criteria_shape_guard
    BEFORE INSERT OR UPDATE OF verification_criteria ON deployments.media_jobs
    FOR EACH ROW EXECUTE FUNCTION deployments.media_jobs_criteria_shape();

-- ---------------------------------------------------------------------------
-- The append-only provider-observation ledger (MOD-011/MOD-013: the
-- normalized closed-vocabulary evidence of polls and callbacks; the
-- observation idempotency ledger). Zeck-side observation_key is the
-- dedupe identity; provider_job_ref is the rail's OPAQUE reference,
-- evidence only; output descriptors are bounded artifact-reference
-- forms — never media bytes.
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.media_observations (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    job_id        uuid NOT NULL,
    deployment_id uuid NOT NULL,
    observation_key text NOT NULL,
    source        text NOT NULL,
    observation   text NOT NULL,
    provider_job_ref text,
    provider_state_label text,
    progress      numeric,
    output_descriptor jsonb,
    execution_id  uuid,
    ledger_sequence bigint,
    actor_id      uuid NOT NULL,
    event_seq     bigint GENERATED ALWAYS AS IDENTITY,
    created_at    timestamptz NOT NULL,
    CONSTRAINT media_obs_vocabulary CHECK (observation IN ('accepted','progressed','provider-completed','provider-failed','provider-cancelled')),
    CONSTRAINT media_obs_source_vocabulary CHECK (source IN ('poll','callback')),
    CONSTRAINT media_obs_progress_range CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
    CONSTRAINT media_obs_key_nonempty CHECK (length(observation_key) BETWEEN 1 AND 200),
    CONSTRAINT media_obs_provider_ref_bounded CHECK (provider_job_ref IS NULL OR length(provider_job_ref) BETWEEN 1 AND 200),
    CONSTRAINT media_obs_provider_label_bounded CHECK (provider_state_label IS NULL OR length(provider_state_label) <= 200),
    CONSTRAINT media_obs_descriptor_bounded CHECK (output_descriptor IS NULL OR pg_column_size(output_descriptor) <= 2048),
    CONSTRAINT media_obs_sequence_positive CHECK (ledger_sequence IS NULL OR ledger_sequence >= 1),
    CONSTRAINT media_obs_key_unique UNIQUE (application_id, job_id, observation_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT media_obs_job_fk FOREIGN KEY (job_id)
        REFERENCES deployments.media_jobs (id)
);

CREATE INDEX media_obs_job_order
    ON deployments.media_observations (application_id, job_id, event_seq);

-- The ledger is append-only (no UPDATE/DELETE — observations are
-- immutable evidence).
CREATE OR REPLACE FUNCTION deployments.media_obs_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.media_observations is append-only (observation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_obs_append_only_guard
    BEFORE UPDATE OR DELETE ON deployments.media_observations
    FOR EACH ROW EXECUTE FUNCTION deployments.media_obs_append_only();

-- Output descriptors are bounded artifact-reference forms: they must
-- be objects and must NEVER carry raw byte payloads (the media bytes
-- live in the canonical artifact plane behind the contentDigest
-- reference).
CREATE OR REPLACE FUNCTION deployments.media_obs_descriptor_shape() RETURNS trigger AS $$ BEGIN IF NEW.output_descriptor IS NULL THEN RETURN NEW; END IF; IF jsonb_typeof(NEW.output_descriptor) <> 'object' THEN RAISE EXCEPTION 'media observation output descriptor must be an object (observation %)', NEW.id; END IF; IF NEW.output_descriptor ? 'contentDigest' AND jsonb_typeof(NEW.output_descriptor->'contentDigest') <> 'string' THEN RAISE EXCEPTION 'media observation contentDigest must be a string digest reference (observation %)', NEW.id; END IF; IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.output_descriptor) k WHERE k IN ('bytes','data','base64','payload')) THEN RAISE EXCEPTION 'media observation output descriptor must not carry raw payload bytes (observation %) — artifact references only', NEW.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_obs_descriptor_shape_guard
    BEFORE INSERT OR UPDATE OF output_descriptor ON deployments.media_observations
    FOR EACH ROW EXECUTE FUNCTION deployments.media_obs_descriptor_shape();

-- ---------------------------------------------------------------------------
-- The immutable artifact-adoption records (MOD-012: generated outputs
-- and derived variants linked to the canonical content-addressed
-- artifact authority's digests, lineage parents and the job's pinned
-- deployment version). One row per adoption; duplicates converge on
-- the physical UNIQUE (application, artifact_key).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.media_artifacts (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    job_id         uuid NOT NULL,
    deployment_id  uuid NOT NULL,
    pinned_plan_id text NOT NULL,
    pinned_plan_version integer NOT NULL,
    execution_id   uuid NOT NULL,
    role           text NOT NULL,
    artifact_key   text NOT NULL,
    artifact_digest text NOT NULL,
    parent_digests jsonb NOT NULL DEFAULT '[]'::jsonb,
    descriptor_digest text NOT NULL,
    ledger_sequence bigint,
    created_by     uuid NOT NULL,
    created_at     timestamptz NOT NULL,
    CONSTRAINT media_art_role_vocabulary CHECK (role IN ('generated-output','derived-variant')),
    CONSTRAINT media_art_key_nonempty CHECK (length(artifact_key) BETWEEN 1 AND 200),
    CONSTRAINT media_art_digest_shape CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_art_descriptor_digest_shape CHECK (descriptor_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT media_art_plan_version_positive CHECK (pinned_plan_version >= 1),
    CONSTRAINT media_art_sequence_positive CHECK (ledger_sequence IS NULL OR ledger_sequence >= 1),
    CONSTRAINT media_art_key_unique UNIQUE (application_id, artifact_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT media_art_job_fk FOREIGN KEY (job_id)
        REFERENCES deployments.media_jobs (id),
    CONSTRAINT media_art_deployment_fk FOREIGN KEY (deployment_id)
        REFERENCES deployments.deployments (id)
);

CREATE INDEX media_art_job_listing
    ON deployments.media_artifacts (application_id, job_id, created_at);

CREATE INDEX media_art_digest_link
    ON deployments.media_artifacts (application_id, artifact_digest);

-- The record is write-once (an adoption's role, digest, lineage
-- parents and deployment-version linkage never move).
CREATE OR REPLACE FUNCTION deployments.media_art_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.media_artifacts is write-once (adoption %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_art_immutable_guard
    BEFORE UPDATE OR DELETE ON deployments.media_artifacts
    FOR EACH ROW EXECUTE FUNCTION deployments.media_art_immutable();

-- Parent digests are ARTIFACT REFERENCES only: every element must be
-- a 64-hex digest string (the lineage linkage to the canonical
-- artifact authority's identity).
CREATE OR REPLACE FUNCTION deployments.media_art_parents_refs() RETURNS trigger AS $$ DECLARE element jsonb; BEGIN IF NEW.parent_digests IS NULL THEN RETURN NEW; END IF; IF jsonb_typeof(NEW.parent_digests) <> 'array' THEN RAISE EXCEPTION 'media artifact parent digests must be a jsonb array (adoption %)', NEW.id; END IF; FOR element IN SELECT jsonb_array_elements(NEW.parent_digests) LOOP IF jsonb_typeof(element) <> 'string' OR element #>> '{}' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'media artifact parent digests must be 64-hex digest references (adoption %)', NEW.id; END IF; END LOOP; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_art_parents_refs_guard
    BEFORE INSERT OR UPDATE OF parent_digests ON deployments.media_artifacts
    FOR EACH ROW EXECUTE FUNCTION deployments.media_art_parents_refs();

-- ---------------------------------------------------------------------------
-- The durable, recoverable media OPERATION state (the WORK-024
-- crash-safety standard). One row per governed media side effect:
-- job-submission, paid-dispatch (exactly one per job — the stable
-- operation key is mediaop:paid-dispatch:<jobId>), observation-apply,
-- job-completion, job-cancellation, variant-adoption: PENDING
-- (claimed, not durably complete — a crash in the claim/completion
-- window leaves this; a retry MUST resume with the STABLE rail-level
-- idempotency keys) -> COMPLETED (the durable outcome exists; replays
-- return it with no side effect) | FAILED (a durably recorded terminal
-- failure outcome).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.media_operations (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    -- Provenance reference WITHOUT FK by design: a job-submission
    -- operation row is durably claimed BEFORE the job row exists
    -- (that ordering is exactly the crash window this ledger closes).
    job_id         uuid,
    deployment_id  uuid NOT NULL,
    execution_id   uuid,
    operation_kind text NOT NULL,
    operation_key  text NOT NULL,
    status         text NOT NULL,
    attempts       integer NOT NULL DEFAULT 1,
    -- Bounded stage checkpoint (the past-the-point-of-no-return facts
    -- a crash-resume completes from; never payloads, never secrets).
    checkpoint     jsonb,
    failure_reason text,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    completed_at   timestamptz,
    CONSTRAINT media_ops_kind_vocabulary CHECK (operation_kind IN ('job-submission','paid-dispatch','observation-apply','job-completion','job-cancellation','variant-adoption')),
    CONSTRAINT media_ops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT media_ops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT media_ops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT media_ops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT media_ops_checkpoint_bounded CHECK (checkpoint IS NULL OR pg_column_size(checkpoint) <= 4096),
    CONSTRAINT media_ops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT media_ops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT media_ops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT media_ops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT media_ops_key_unique UNIQUE (application_id, operation_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX media_ops_job_listing
    ON deployments.media_operations (application_id, job_id, created_at);

CREATE INDEX media_ops_pending_scan
    ON deployments.media_operations (application_id, status, updated_at)
    WHERE status = 'pending';

-- The identity core is write-once: application/tenant/deployment
-- binding, the operation kind and key, the job/execution provenance
-- references and the creation timestamp never move.
CREATE OR REPLACE FUNCTION deployments.media_ops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.media_operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_ops_core_guard
    BEFORE UPDATE ON deployments.media_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.media_ops_core_immutable();

-- The recoverable status machine: only PENDING may move (to
-- COMPLETED or FAILED, with the outcome fields set atomically);
-- COMPLETED/FAILED are terminal-immutable (checkpoint/failure/
-- reason/timestamps frozen); attempts never regress. A physical
-- UPDATE of a terminal row is unrepresentable.
CREATE OR REPLACE FUNCTION deployments.media_ops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'deployments.media_operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) THEN RAISE EXCEPTION 'media operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_ops_lifecycle_guard
    BEFORE UPDATE ON deployments.media_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.media_ops_lifecycle();

CREATE OR REPLACE FUNCTION deployments.media_ops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.media_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER media_ops_no_delete_guard
    BEFORE DELETE ON deployments.media_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.media_ops_no_delete();
