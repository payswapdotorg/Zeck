-- WORK-030 — Training, batch GPU and specialized accelerator workloads
-- (ACC-001/002/003).
--
-- The durable state of the governed training/batch/accelerator fabric:
-- the WORKLOAD journal (idempotent admission rows, immutable runtime
-- metadata, guarded allocation/run/finalize transitions, the
-- write-once verification-release binding), the append-only
-- content/lineage-addressable CHECKPOINT ledger, the DURABLE,
-- RECOVERABLE OPERATION STATE (the WORK-024 crash-safety standard:
-- PENDING -> COMPLETED|FAILED, stable keys, monotonic attempts, stage
-- checkpoints, terminal immutability) and the training RUN LEASE
-- (single-owner, monotonic epochs, one-way release).
--
-- ARCHITECTURE PRESERVATION (the Work Order's invariants):
--   * training and batch workloads are EXECUTIONS: every
--     execution-bound row references the EXISTING execution identity
--     through the composite key (execution_id, application_id) ->
--     executions.executions and (application_id, tenant_id) ->
--     applications.applications — there is NO second execution
--     identity and NO second lifecycle here; execution status is NEVER
--     written by this schema's triggers or tables. Training provenance
--     rides the CANONICAL EventEnvelope ledger through the executions
--     public recordStepEvent seam (the EXISTING step-event vocabulary —
--     WORK-030 adds no vocabulary);
--   * resource and cost admission occur BEFORE paid compute allocation:
--     this schema stores the admission evidence (policy evidence,
--     capability satisfaction, budget operation id, the explicit
--     resource estimate in the immutable runtime metadata) — the
--     PAID allocation columns (allocation_id/substrate_id/adapter_ref)
--     are written only by the allocation step that the service runs
--     strictly after the budgets-authority reservation;
--   * verification-before-release: the release dimension
--     (verified_release_at / verification_evaluation_id) is WRITE-ONCE
--     and can only ever be set together (never unset, never re-bound) —
--     a completed-but-unverified workload is a durable non-release and
--     a FAILED workload can never carry one (CHECK constraint);
--   * resource selection remains provider-neutral: the durable columns
--     carry the neutral substrate identity, the OPAQUE adapter
--     reference and the neutral resource class — no vendor vocabulary
--     exists in any column, constraint or trigger of this migration.
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * sandbox.training_workloads: UNIQUE (application_id, workload_key)
--     convergence; denied rows insert-only; completed/cancelled rows
--     fully immutable; failed rows immutable except the guarded retry
--     re-arm; runtime_metadata IMMUTABLE on every update path; the
--     ledger bindings, allocation binding, resume pointer, output
--     adoption and release binding are each write-once monotonic;
--     rows never deleted;
--   * sandbox.training_checkpoints: APPEND-ONLY (no UPDATE/DELETE),
--     UNIQUE (application_id, content_digest) — the checkpoint
--     IDENTITY is the immutable content digest (content-addressable;
--     the lineage refs live inside the digest-covered contents, so the
--     identity is lineage-addressable too) — plus UNIQUE
--     (application_id, workload_id, checkpoint_sequence) with a
--     single-statement count-gated gapless sequence (the 0022
--     discipline, with the 0025 single-statement snapshot-collapse
--     hardening);
--   * sandbox.training_operations: PENDING -> COMPLETED|FAILED only,
--     terminal rows fully immutable, identity core immutable, attempts
--     monotonic, stable-key UNIQUE claim (application_id,
--     operation_key), rows never deleted;
--   * sandbox.training_run_leases: ONE ROW per (application_id,
--     workload_id), guarded transitions — the epoch is strictly
--     monotonic on re-acquisition, heartbeats never regress, within
--     one epoch the owner never moves and the expiry never shortens,
--     release is one-way, rows never deleted.
--
-- INHERITED DEFECT FIX (edge module, migration 0024 — disclosed in
-- docs/work-items/WORK-030.md): the BEFORE-INSERT trigger functions
-- edge.ec_commands_sequence_gate and edge.es_observations_sequence_gate
-- (migration 0024) ran MULTIPLE separate SELECT statements
-- (by-sequence existence, by-key existence, then COUNT(*)); under READ
-- COMMITTED each statement takes its own snapshot, so one trigger
-- invocation could observe pre-commit snapshots for the existence
-- checks and a post-commit snapshot for the COUNT — statement-snapshot
-- tearing — raising a spurious gapless error instead of same-key
-- convergence (the baseline stress runs failed ~3 of 11 runs with
-- "command sequence must be gapless (expected 2, got 1)"). THE FIX
-- (forward-only, semantics-preserving): each gate's lookups are
-- collapsed into ONE statement (a single SELECT of scalar subqueries)
-- so every check sees one snapshot; the decision logic and the error
-- messages are UNCHANGED. Migration 0024 is never edited (the
-- forward-only discipline); the replacement functions live HERE.
--
-- Migration-version discipline (the collision rule, parallel waves):
-- the live inventory at authoring time is 0001..0014, 0016..0024 (0015
-- is BURNED — WORK-019's owned number, absent from the tree; 0022 =
-- WORK-028, 0023 = WORK-027, 0024 = WORK-029). **WORK-030 claims 0025
-- — THIS migration. No other unmerged Work Order claims 0025.**
-- (Convention pinned in docs/work-items/WORK-018.md § migration
-- discipline.)

CREATE TABLE sandbox.training_workloads (
    id                       uuid PRIMARY KEY,
    application_id           uuid NOT NULL,
    tenant_id                uuid NOT NULL,
    execution_id             uuid NOT NULL,
    workload_key             text NOT NULL,
    request_fingerprint      text NOT NULL,
    workload_kind            text NOT NULL,
    status                   text NOT NULL,
    runtime_metadata         jsonb NOT NULL,
    denial_class             text,
    denial_code              text,
    denial_reason            text,
    attempts                 integer NOT NULL DEFAULT 1,
    failure_class            text,
    failure_message          text,
    output_artifact_digest   text,
    output_descriptor        jsonb,
    usage_micro_usd          text,
    budget_operation_id      text,
    allocation_id            text,
    substrate_id             text,
    adapter_ref              text,
    last_checkpoint_identity text,
    verified_release_at      timestamptz,
    verification_evaluation_id text,
    ledger_admitted_sequence integer,
    ledger_completed_sequence integer,
    created_at               timestamptz NOT NULL,
    allocated_at             timestamptz,
    started_at               timestamptz,
    completed_at             timestamptz,
    cancelled_at             timestamptz,
    CONSTRAINT tw_status_vocabulary CHECK (status IN ('denied','admitted','allocating','running','completed','failed','cancelled')),
    CONSTRAINT tw_kind_vocabulary CHECK (workload_kind IN ('training','fine-tuning','batch-inference','evaluation')),
    CONSTRAINT tw_key_bounded CHECK (length(workload_key) BETWEEN 1 AND 200),
    CONSTRAINT tw_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 4000),
    CONSTRAINT tw_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT tw_denial_shape CHECK ((status = 'denied') = (denial_class IS NOT NULL AND denial_code IS NOT NULL AND denial_reason IS NOT NULL)),
    CONSTRAINT tw_denial_class_vocabulary CHECK (denial_class IS NULL OR denial_class IN ('policy','budget','capability')),
    CONSTRAINT tw_denial_code_vocabulary CHECK (denial_code IS NULL OR denial_code IN ('POLICY_DENIED','BUDGET_EXCEEDED','CAPABILITY_UNAVAILABLE')),
    CONSTRAINT tw_failure_vocabulary CHECK (failure_class IS NULL OR failure_class IN ('workload-failure','timeout','substrate-error','substrate-unavailable','convergence-loss')),
    CONSTRAINT tw_denied_no_outcome CHECK (status <> 'denied' OR (failure_class IS NULL AND failure_message IS NULL AND output_artifact_digest IS NULL AND output_descriptor IS NULL AND usage_micro_usd IS NULL AND allocation_id IS NULL AND verified_release_at IS NULL)),
    CONSTRAINT tw_digest_shape CHECK (output_artifact_digest IS NULL OR output_artifact_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT tw_checkpoint_identity_shape CHECK (last_checkpoint_identity IS NULL OR last_checkpoint_identity ~ '^[0-9a-f]{64}$'),
    CONSTRAINT tw_release_shape CHECK ((verified_release_at IS NULL) = (verification_evaluation_id IS NULL)),
    CONSTRAINT tw_release_completed_only CHECK (verified_release_at IS NULL OR status = 'completed'),
    CONSTRAINT tw_terminal_completion_shape CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT tw_cancelled_shape CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
    CONSTRAINT tw_metadata_shape CHECK (jsonb_typeof(runtime_metadata) = 'object'),
    CONSTRAINT tw_descriptor_shape CHECK (output_descriptor IS NULL OR jsonb_typeof(output_descriptor) = 'object'),
    CONSTRAINT tw_key_unique UNIQUE (application_id, workload_key),
    CONSTRAINT tw_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT tw_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX tw_by_execution
    ON sandbox.training_workloads (application_id, execution_id, created_at);

CREATE INDEX tw_by_status
    ON sandbox.training_workloads (application_id, status, created_at);

-- The workload lifecycle guard: the legal transitions only, terminal
-- immutability, the IMMUTABLE admitted snapshot, and the write-once
-- monotonic bindings. (Failed rows are immutable EXCEPT the guarded
-- retry re-arm into 'allocating' — the stable-identity retry ladder.)
CREATE OR REPLACE FUNCTION sandbox.tw_lifecycle_guard() RETURNS trigger AS $$ BEGIN
    IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.workload_key <> OLD.workload_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.workload_kind <> OLD.workload_kind OR NEW.runtime_metadata <> OLD.runtime_metadata OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'training workload % identity core (incl. runtime_metadata) is immutable', OLD.id;
    END IF;
    IF OLD.status IN ('denied','completed','cancelled') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'training workload % is terminal-immutable in status %', OLD.id, OLD.status;
    END IF;
    IF OLD.status = 'denied' AND (NEW.denial_class, NEW.denial_code, NEW.denial_reason) IS DISTINCT FROM (OLD.denial_class, OLD.denial_code, OLD.denial_reason) THEN
        RAISE EXCEPTION 'denied training workload % is insert-only', OLD.id;
    END IF;
    IF NOT (
        (OLD.status = 'admitted' AND NEW.status IN ('admitted','allocating','cancelled'))
        OR (OLD.status = 'allocating' AND NEW.status IN ('allocating','running','failed','cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN ('running','completed','failed','cancelled'))
        OR (OLD.status = 'failed' AND NEW.status IN ('failed','allocating'))
        OR (OLD.status = 'completed' AND NEW.status = 'completed')
        OR (OLD.status = 'cancelled' AND NEW.status = 'cancelled')
    ) THEN
        RAISE EXCEPTION 'training workload % cannot move from status % to %', OLD.id, OLD.status, NEW.status;
    END IF;
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'training workload % attempt ledger is monotonic (% -> %)', OLD.id, OLD.attempts, NEW.attempts;
    END IF;
    IF (OLD.status = 'failed' AND NEW.status = 'allocating' AND NEW.attempts <> OLD.attempts) THEN
        RAISE EXCEPTION 'training workload % retry re-arm requires the attempt ledger to advance', OLD.id;
    END IF;
    IF NEW.ledger_admitted_sequence IS DISTINCT FROM OLD.ledger_admitted_sequence AND (OLD.ledger_admitted_sequence IS NOT NULL OR NEW.ledger_admitted_sequence IS NULL) THEN
        RAISE EXCEPTION 'training workload % admitted ledger binding is write-once', OLD.id;
    END IF;
    IF NEW.ledger_completed_sequence IS DISTINCT FROM OLD.ledger_completed_sequence AND (OLD.ledger_completed_sequence IS NOT NULL OR NEW.ledger_completed_sequence IS NULL) THEN
        RAISE EXCEPTION 'training workload % completed ledger binding is write-once', OLD.id;
    END IF;
    IF NEW.allocation_id IS NOT NULL AND NEW.allocation_id <> coalesce(OLD.allocation_id, NEW.allocation_id) THEN
        RAISE EXCEPTION 'training workload % allocation binding is write-once (first allocation wins)', OLD.id;
    END IF;
    IF OLD.output_artifact_digest IS NOT NULL AND NEW.output_artifact_digest <> OLD.output_artifact_digest THEN
        RAISE EXCEPTION 'training workload % output adoption is write-once', OLD.id;
    END IF;
    IF OLD.verified_release_at IS NOT NULL AND (NEW.verified_release_at <> OLD.verified_release_at OR NEW.verification_evaluation_id <> OLD.verification_evaluation_id) THEN
        RAISE EXCEPTION 'training workload % verification-release binding is write-once (never re-bound)', OLD.id;
    END IF;
    IF OLD.completed_at IS NOT NULL AND NEW.completed_at <> OLD.completed_at THEN
        RAISE EXCEPTION 'training workload % completion timestamp is write-once', OLD.id;
    END IF;
    IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at <> OLD.cancelled_at THEN
        RAISE EXCEPTION 'training workload % cancellation timestamp is write-once', OLD.id;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tw_lifecycle_guard
    BEFORE UPDATE ON sandbox.training_workloads
    FOR EACH ROW EXECUTE FUNCTION sandbox.tw_lifecycle_guard();

CREATE OR REPLACE FUNCTION sandbox.tw_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.training_workloads rows are never deleted (workload %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tw_no_delete_guard
    BEFORE DELETE ON sandbox.training_workloads
    FOR EACH ROW EXECUTE FUNCTION sandbox.tw_no_delete();

-- The workload insert gate: an admitted workload binds to a
-- NON-TERMINAL execution, and denied rows carry no outcome columns.
CREATE OR REPLACE FUNCTION sandbox.tw_insert_gate() RETURNS trigger AS $$ DECLARE terminal boolean; BEGIN
    IF NEW.status NOT IN ('denied','admitted') THEN
        RAISE EXCEPTION 'training workloads are inserted in denied|admitted only (got %)', NEW.status;
    END IF;
    SELECT status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED') INTO terminal FROM executions.executions WHERE id = NEW.execution_id AND application_id = NEW.application_id;
    IF terminal IS NULL THEN
        RAISE EXCEPTION 'execution % does not exist in application %', NEW.execution_id, NEW.application_id;
    END IF;
    IF terminal AND NEW.status <> 'denied' THEN
        RAISE EXCEPTION 'execution % is terminal; no training workload may be admitted on it', NEW.execution_id;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tw_insert_gate
    BEFORE INSERT ON sandbox.training_workloads
    FOR EACH ROW EXECUTE FUNCTION sandbox.tw_insert_gate();

-- ---------------------------------------------------------------------------
-- The checkpoint ledger: append-only; identity = the immutable content
-- digest (UNIQUE per application — content-addressable; the lineage
-- refs live inside the digest-covered contents, so the identity is
-- lineage-addressable too); per-workload gapless sequence, gated in a
-- SINGLE statement (the 0025 snapshot-collapse hardening of the 0022
-- pattern: one SELECT of scalar subqueries — one snapshot for the
-- by-sequence, by-identity and count checks alike).
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.training_checkpoints (
    id                  uuid PRIMARY KEY,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    execution_id        uuid NOT NULL,
    workload_id         uuid NOT NULL,
    workload_key        text NOT NULL,
    checkpoint_sequence integer NOT NULL,
    step_position       integer NOT NULL,
    lineage             jsonb NOT NULL,
    metrics_digest      text NOT NULL,
    substrate_id        text NOT NULL,
    resource_class      text NOT NULL,
    recorded_by         text NOT NULL,
    content_digest      text NOT NULL,
    created_at          timestamptz NOT NULL,
    CONSTRAINT tc_sequence_positive CHECK (checkpoint_sequence >= 1),
    CONSTRAINT tc_step_positive CHECK (step_position >= 1),
    CONSTRAINT tc_lineage_shape CHECK (jsonb_typeof(lineage) = 'object'),
    CONSTRAINT tc_metrics_digest_shape CHECK (metrics_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT tc_content_digest_shape CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT tc_identity_unique UNIQUE (application_id, content_digest),
    CONSTRAINT tc_sequence_unique UNIQUE (application_id, workload_id, checkpoint_sequence),
    CONSTRAINT tc_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT tc_workload_fk
        FOREIGN KEY (workload_id, application_id)
        REFERENCES sandbox.training_workloads (id, application_id)
);

CREATE INDEX tc_by_workload
    ON sandbox.training_checkpoints (application_id, workload_id, checkpoint_sequence);

CREATE INDEX tc_by_execution
    ON sandbox.training_checkpoints (application_id, execution_id, created_at);

CREATE OR REPLACE FUNCTION sandbox.tc_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.training_checkpoints is append-only (rejected % on checkpoint %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tc_no_mutation
    BEFORE UPDATE OR DELETE ON sandbox.training_checkpoints
    FOR EACH ROW EXECUTE FUNCTION sandbox.tc_append_only();

-- Convergence-aware gapless sequence gate, single-statement snapshot:
-- if the concurrent insert is committed, the by-identity check finds
-- it and the same-content duplicate passes through to the arbiter; if
-- it is in flight, nothing is visible and COUNT validates the next
-- sequence — the insert then waits on the unique arbiter and converges.
CREATE OR REPLACE FUNCTION sandbox.tc_sequence_gate() RETURNS trigger AS $$
DECLARE
    existing_digest text;
    total integer;
BEGIN
    SELECT (SELECT tc.content_digest FROM sandbox.training_checkpoints tc WHERE tc.application_id = NEW.application_id AND tc.workload_id = NEW.workload_id AND tc.checkpoint_sequence = NEW.checkpoint_sequence),
           (SELECT COUNT(*) FROM sandbox.training_checkpoints tc WHERE tc.application_id = NEW.application_id AND tc.workload_id = NEW.workload_id)
    INTO existing_digest, total;
    IF existing_digest IS NOT NULL THEN
        IF existing_digest = NEW.content_digest THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'training workload % checkpoint sequence % already exists with a different content identity', NEW.workload_id, NEW.checkpoint_sequence;
    END IF;
    IF NEW.checkpoint_sequence IS DISTINCT FROM total + 1 THEN
        RAISE EXCEPTION 'training workload % checkpoint sequence must be gapless (expected %, got %)', NEW.workload_id, total + 1, NEW.checkpoint_sequence;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tc_sequence_gate
    BEFORE INSERT ON sandbox.training_checkpoints
    FOR EACH ROW EXECUTE FUNCTION sandbox.tc_sequence_gate();

-- ---------------------------------------------------------------------------
-- The durable, recoverable operation state (the WORK-024 standard).
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.training_operations (
    id                 uuid PRIMARY KEY,
    application_id     uuid NOT NULL,
    tenant_id          uuid NOT NULL,
    execution_id       uuid NOT NULL,
    workload_id        uuid,
    operation_kind     text NOT NULL,
    operation_key      text NOT NULL,
    request_fingerprint text NOT NULL,
    status             text NOT NULL DEFAULT 'pending',
    attempts           integer NOT NULL DEFAULT 1,
    stage              jsonb,
    failure_reason     text,
    created_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    completed_at       timestamptz,
    CONSTRAINT to_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT to_kind_vocabulary CHECK (operation_kind IN ('submit','allocate','run','checkpoint','cancel','resume','retry','publish-output','release')),
    CONSTRAINT to_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 250),
    CONSTRAINT to_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT to_stage_shape CHECK (stage IS NULL OR jsonb_typeof(stage) = 'object'),
    CONSTRAINT to_completed_shape CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND failure_reason IS NULL)),
    CONSTRAINT to_failed_shape CHECK (status <> 'failed' OR (completed_at IS NOT NULL AND failure_reason IS NOT NULL)),
    CONSTRAINT to_pending_shape CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT to_key_unique UNIQUE (application_id, operation_key),
    CONSTRAINT to_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT to_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT to_workload_fk
        FOREIGN KEY (workload_id, application_id)
        REFERENCES sandbox.training_workloads (id, application_id)
);

CREATE INDEX to_by_execution
    ON sandbox.training_operations (application_id, execution_id, created_at);

CREATE INDEX to_pending_scan
    ON sandbox.training_operations (application_id, status, updated_at)
    WHERE status = 'pending';

CREATE OR REPLACE FUNCTION sandbox.to_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.workload_id IS DISTINCT FROM OLD.workload_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'sandbox.training_operations identity core is immutable (operation %)', OLD.id; END IF; IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'training operation % attempt ledger is monotonic (% -> %)', OLD.id, OLD.attempts, NEW.attempts; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER to_core_guard
    BEFORE UPDATE ON sandbox.training_operations
    FOR EACH ROW EXECUTE FUNCTION sandbox.to_core_immutable();

CREATE OR REPLACE FUNCTION sandbox.to_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'sandbox.training_operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) THEN RAISE EXCEPTION 'training operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER to_lifecycle_guard
    BEFORE UPDATE ON sandbox.training_operations
    FOR EACH ROW EXECUTE FUNCTION sandbox.to_lifecycle();

CREATE OR REPLACE FUNCTION sandbox.to_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.training_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER to_no_delete_guard
    BEFORE DELETE ON sandbox.training_operations
    FOR EACH ROW EXECUTE FUNCTION sandbox.to_no_delete();

-- ---------------------------------------------------------------------------
-- The training run lease: ONE ROW per (application_id, workload_id);
-- guarded transitions — the epoch is strictly monotonic on
-- re-acquisition, heartbeats never regress, within one epoch the owner
-- never moves and the expiry never shortens, release is one-way.
-- ---------------------------------------------------------------------------

CREATE TABLE sandbox.training_run_leases (
    workload_id       uuid NOT NULL,
    application_id    uuid NOT NULL,
    tenant_id         uuid NOT NULL,
    execution_id      uuid NOT NULL,
    owner_id          text NOT NULL,
    epoch             integer NOT NULL,
    acquired_at       timestamptz NOT NULL,
    expires_at        timestamptz NOT NULL,
    last_heartbeat_at timestamptz NOT NULL,
    heartbeat_count   integer NOT NULL,
    released_at       timestamptz,
    release_cause     text,
    CONSTRAINT tl_epoch_positive CHECK (epoch >= 1),
    CONSTRAINT tl_heartbeat_positive CHECK (heartbeat_count >= 1),
    CONSTRAINT tl_release_cause_vocabulary CHECK (release_cause IS NULL OR release_cause IN ('run-completed','run-failed','worker-released','cancelled')),
    CONSTRAINT tl_release_shape CHECK ((released_at IS NULL) = (release_cause IS NULL)),
    CONSTRAINT tl_pk PRIMARY KEY (application_id, workload_id),
    CONSTRAINT tl_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT tl_workload_fk
        FOREIGN KEY (workload_id, application_id)
        REFERENCES sandbox.training_workloads (id, application_id)
);

CREATE OR REPLACE FUNCTION sandbox.tl_lease_guards() RETURNS trigger AS $$ BEGIN IF NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.workload_id <> OLD.workload_id THEN RAISE EXCEPTION 'sandbox.training_run_leases identity core is immutable (lease of workload %)', OLD.workload_id; END IF; IF NEW.epoch < OLD.epoch THEN RAISE EXCEPTION 'training workload % lease epoch must not regress (% -> %)', OLD.workload_id, OLD.epoch, NEW.epoch; END IF; IF NEW.heartbeat_count < OLD.heartbeat_count THEN RAISE EXCEPTION 'training workload % lease heartbeat count must not regress (% -> %)', OLD.workload_id, OLD.heartbeat_count, NEW.heartbeat_count; END IF; IF NEW.epoch = OLD.epoch THEN IF NEW.owner_id <> OLD.owner_id THEN RAISE EXCEPTION 'training workload % lease owner cannot change within epoch % (re-acquisition advances the epoch)', OLD.workload_id, OLD.epoch; END IF; IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'training workload % lease is released; it can only be re-acquired at a new epoch', OLD.workload_id; END IF; IF NEW.released_at IS NULL AND NEW.expires_at < OLD.expires_at THEN RAISE EXCEPTION 'training workload % lease expiry must not shorten within epoch %', OLD.workload_id, OLD.epoch; END IF; END IF; IF NEW.released_at IS NOT NULL AND NEW.released_at < NEW.acquired_at THEN RAISE EXCEPTION 'training workload % lease release precedes acquisition', OLD.workload_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tl_lease_guards
    BEFORE UPDATE ON sandbox.training_run_leases
    FOR EACH ROW EXECUTE FUNCTION sandbox.tl_lease_guards();

CREATE OR REPLACE FUNCTION sandbox.tl_lease_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sandbox.training_run_leases rows are never deleted (lease of workload %)', OLD.workload_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tl_lease_no_delete_guard
    BEFORE DELETE ON sandbox.training_run_leases
    FOR EACH ROW EXECUTE FUNCTION sandbox.tl_lease_no_delete();

-- ---------------------------------------------------------------------------
-- THE INHERITED EDGE-GATE DEFECT FIX (migration 0024's functions,
-- fixed forward HERE — 0024 is never edited; root cause + rationale in
-- the header above and in docs/work-items/WORK-030.md).
--
-- Single-statement lookup collapse: one SELECT of scalar subqueries
-- INTO the decision variables, so the by-sequence lookup, the by-key
-- lookup and the COUNT all see ONE statement snapshot (READ COMMITTED
-- takes one snapshot per STATEMENT — collapsing the statements
-- collapses the snapshots). The decision logic and every error message
-- are byte-identical to the 0024 semantics; only the lookup shape
-- changed (semantics-preserving).
--
-- If the concurrent insert is committed: the key/digest check finds it
-- and passes through (same-key convergence via the ON CONFLICT
-- arbiter). If it is in flight: nothing is visible, COUNT validates
-- sequence N — the insert then waits on the unique arbiter and
-- converges via ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION edge.ec_commands_sequence_gate() RETURNS trigger AS $$
DECLARE
    existing_key text;
    existing_fingerprint text;
    total integer;
BEGIN
    SELECT (SELECT command_key FROM edge.commands WHERE application_id = NEW.application_id AND device_id = NEW.device_id AND sequence = NEW.sequence),
           (SELECT request_fingerprint FROM edge.commands WHERE application_id = NEW.application_id AND command_key = NEW.command_key),
           (SELECT COUNT(*) FROM edge.commands WHERE application_id = NEW.application_id AND device_id = NEW.device_id)
    INTO existing_key, existing_fingerprint, total;
    IF existing_key IS NOT NULL THEN
        IF existing_key = NEW.command_key THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'edge device % command sequence % already exists with a different key', NEW.device_id, NEW.sequence;
    END IF;
    IF existing_fingerprint IS NOT NULL THEN
        IF existing_fingerprint = NEW.request_fingerprint THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'edge command key % was already used with a different request (key reuse)', NEW.command_key;
    END IF;
    IF NEW.sequence IS DISTINCT FROM total + 1 THEN
        RAISE EXCEPTION 'edge device % command sequence must be gapless (expected %, got %)', NEW.device_id, total + 1, NEW.sequence;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION edge.es_observations_sequence_gate() RETURNS trigger AS $$
DECLARE
    existing_digest text;
    total integer;
BEGIN
    SELECT (SELECT content_digest FROM edge.sensor_observations WHERE application_id = NEW.application_id AND observation_key = NEW.observation_key),
           (SELECT COUNT(*) FROM edge.sensor_observations WHERE application_id = NEW.application_id AND device_id = NEW.device_id)
    INTO existing_digest, total;
    IF existing_digest IS NOT NULL THEN
        IF existing_digest = NEW.content_digest THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'edge sensor observation key % was already used with different content (key reuse)', NEW.observation_key;
    END IF;
    IF NEW.sequence IS DISTINCT FROM total + 1 THEN
        RAISE EXCEPTION 'edge device % sensor observation sequence must be gapless (expected %, got %)', NEW.device_id, total + 1, NEW.sequence;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

