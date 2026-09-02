-- WORK-028 — Long-running and resumable execution (LNG-001/002/003).
--
-- The durable state of the long-running execution extension: CHECKPOINTS
-- (write-once, digest-protected, per-execution sequence), the execution
-- LEASE (single live row per execution, guarded owner/epoch transitions,
-- monotonic epochs/heartbeats), WAKE-UPS (deterministic due-ordering,
-- write-once application) and the DURABLE, RECOVERABLE OPERATION STATE
-- (the WORK-024 crash-safety standard: PENDING -> COMPLETED|FAILED,
-- stable keys, monotonic attempts, stage checkpoints, terminal
-- immutability).
--
-- AUTHORITY PRESERVATION (the frozen invariants + this Work Order):
--   * every table references the EXISTING execution identity through the
--     composite key (execution_id, application_id) -> executions.executions
--     — there is NO second execution identity, no second lifecycle and no
--     second event ledger anywhere in this migration. Checkpoints/leases/
--     wake-ups/operations are EXTENSIONS keyed by the frozen identity;
--   * execution status is NEVER written here: pause/resume/termination
--     move the lifecycle ONLY through the frozen transition commands
--     (wait-tool/wait-user/wait-human/resume/cancel) of the single write
--     path (migration 0004's triggers remain the physical authority);
--   * checkpoint/resume provenance rides the CANONICAL EventEnvelope
--     ledger through the executions public recordStepEvent seam (the
--     additive step-event vocabulary of domain/event.ts); these tables
--     store durable state, never a second event stream.
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * execution_checkpoints: APPEND-ONLY (no UPDATE/DELETE), per-execution
--     gapless checkpoint_sequence (UNIQUE + count-gated insert trigger —
--     a checkpoint is exactly the Nth checkpoint of its execution),
--     content-digest protected (64 hex), identity core bound to a
--     NON-TERMINAL execution at insert time;
--   * execution_leases: ONE ROW per execution (PK), guarded transitions
--     — the epoch is strictly monotonic on re-acquisition, heartbeats
--     never regress, within one epoch the owner never moves and the
--     expiry never shortens, release is one-way (released_at/cause set
--     atomically), a lease may only be acquired on a terminal-free
--     execution;
--   * execution_wakeups: the status machine scheduled -> applied |
--     superseded with NO outgoing edge from the terminal states,
--     applied/superseded are write-once (the applied operation key is
--     immutable once set), rows never deleted, due-ordering index on
--     (earliest_wake_at, id) restricted to scheduled rows;
--   * execution_operations: the realtime_operations/messaging_operations
--     discipline — PENDING -> COMPLETED|FAILED only, terminal rows fully
--     immutable, attempts monotonic, the stage checkpoint writable only
--     while PENDING, outcome-field exclusivity, stable-key UNIQUE claim
--     (application_id, operation_key), rows never deleted.
--
-- Migration-version discipline (the collision rule, parallel wave-4):
-- the live inventory at authoring time is 0001..0014, 0016..0020 (0015
-- is BURNED — WORK-019's owned number, absent from the tree; 0016 =
-- WORK-022, 0017 = WORK-020, 0018 = WORK-024, 0019 = WORK-021, 0020 =
-- WORK-025). The sibling WORK-026 claims 0021 (its file is NOT in this
-- branch). **WORK-028 claims 0022 — THIS migration. No other unmerged
-- Work Order claims 0022.** (Convention pinned in
-- docs/work-items/WORK-018.md § migration discipline.)

CREATE TABLE executions.execution_checkpoints (
    id                  uuid PRIMARY KEY,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    execution_id        uuid NOT NULL,
    checkpoint_sequence integer NOT NULL,
    plan_id             text NOT NULL,
    plan_revision       integer NOT NULL,
    context_artifacts   jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_event_position integer NOT NULL,
    resource_class      text NOT NULL,
    environment_id      uuid,
    environment_spec_digest text,
    required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    max_cost_micro_usd  text,
    content_digest      text NOT NULL,
    recorded_by         text NOT NULL,
    created_at          timestamptz NOT NULL,
    CONSTRAINT lr_checkpoint_sequence_positive CHECK (checkpoint_sequence >= 1),
    CONSTRAINT lr_checkpoint_plan_id_nonempty CHECK (length(plan_id) BETWEEN 1 AND 200),
    CONSTRAINT lr_checkpoint_plan_revision_positive CHECK (plan_revision >= 1),
    CONSTRAINT lr_checkpoint_artifacts_shape CHECK (jsonb_typeof(context_artifacts) = 'array'),
    CONSTRAINT lr_checkpoint_position_positive CHECK (last_event_position >= 1),
    CONSTRAINT lr_checkpoint_resource_class_nonempty CHECK (length(resource_class) BETWEEN 1 AND 100),
    CONSTRAINT lr_checkpoint_caps_shape CHECK (jsonb_typeof(required_capabilities) = 'array'),
    CONSTRAINT lr_checkpoint_digest_shape CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT lr_checkpoint_cost_shape CHECK (max_cost_micro_usd IS NULL OR max_cost_micro_usd ~ '^[0-9]{1,19}$'),
    CONSTRAINT lr_checkpoint_spec_digest_shape CHECK (environment_spec_digest IS NULL OR environment_spec_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT lr_checkpoint_recorded_by_nonempty CHECK (length(recorded_by) BETWEEN 1 AND 200),
    CONSTRAINT lr_checkpoint_sequence_unique UNIQUE (execution_id, checkpoint_sequence),
    CONSTRAINT lr_checkpoint_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT lr_checkpoint_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX lr_checkpoints_by_execution
    ON executions.execution_checkpoints (application_id, execution_id, checkpoint_sequence);

CREATE OR REPLACE FUNCTION executions.lr_checkpoints_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'executions.execution_checkpoints is append-only (rejected % on checkpoint %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_checkpoints_no_mutation
    BEFORE UPDATE OR DELETE ON executions.execution_checkpoints
    FOR EACH ROW EXECUTE FUNCTION executions.lr_checkpoints_append_only();

-- A checkpoint is exactly the NEXT checkpoint of its execution (the
-- count gate keeps the per-execution sequence gapless) and binds to a
-- NON-TERMINAL execution at insert time (terminal executions accept no
-- further checkpoints — the recovery tail converges through the
-- operation state instead). CONVERGENCE-AWARE: the store inserts with
-- ON CONFLICT (execution_id, checkpoint_sequence) DO NOTHING, and a
-- BEFORE-INSERT trigger runs BEFORE the conflict arbiter — so an exact
-- duplicate (same sequence + same content digest, the crash-resume
-- re-issue of an already-committed checkpoint) must pass this gate and
-- let the UNIQUE constraint deduplicate it (one row survives; the
-- store's convergence read returns it). A same-sequence/different-digest
-- insert is PHYSICAL key reuse and fails closed right here.
CREATE OR REPLACE FUNCTION executions.lr_checkpoint_sequence_gate() RETURNS trigger AS $$ DECLARE existing integer; existing_digest text; terminal boolean; BEGIN SELECT content_digest INTO existing_digest FROM executions.execution_checkpoints WHERE execution_id = NEW.execution_id AND checkpoint_sequence = NEW.checkpoint_sequence; IF existing_digest IS NOT NULL THEN IF existing_digest = NEW.content_digest THEN RETURN NEW; END IF; RAISE EXCEPTION 'execution % checkpoint sequence % already exists with a different content digest (same key, different body)', NEW.execution_id, NEW.checkpoint_sequence; END IF; SELECT COUNT(*) INTO existing FROM executions.execution_checkpoints WHERE execution_id = NEW.execution_id; IF NEW.checkpoint_sequence IS DISTINCT FROM existing + 1 THEN RAISE EXCEPTION 'execution % checkpoint sequence must be gapless (expected %, got %)', NEW.execution_id, existing + 1, NEW.checkpoint_sequence; END IF; SELECT status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED') INTO terminal FROM executions.executions WHERE id = NEW.execution_id AND application_id = NEW.application_id; IF terminal IS NULL THEN RAISE EXCEPTION 'execution % does not exist in application %', NEW.execution_id, NEW.application_id; END IF; IF terminal THEN RAISE EXCEPTION 'execution % is terminal; checkpoints are append-only evidence of a LIVE execution', NEW.execution_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_checkpoint_sequence_gate
    BEFORE INSERT ON executions.execution_checkpoints
    FOR EACH ROW EXECUTE FUNCTION executions.lr_checkpoint_sequence_gate();

-- ---------------------------------------------------------------------------
-- The execution lease: ONE row per execution; guarded owner/epoch
-- transitions. Acquiring a free (absent/expired/released) lease takes
-- epoch = prior + 1 (monotonic — a stale worker's (owner, epoch) pair
-- can never match again). The expiry within one epoch never shortens;
-- heartbeats never regress; release is one-way with a cause.
-- ---------------------------------------------------------------------------

CREATE TABLE executions.execution_leases (
    execution_id      uuid PRIMARY KEY,
    application_id    uuid NOT NULL,
    tenant_id         uuid NOT NULL,
    owner_id          text NOT NULL,
    epoch             integer NOT NULL,
    acquired_at       timestamptz NOT NULL,
    expires_at        timestamptz NOT NULL,
    last_heartbeat_at timestamptz NOT NULL,
    heartbeat_count   integer NOT NULL DEFAULT 0,
    released_at       timestamptz,
    release_cause     text,
    updated_at        timestamptz NOT NULL,
    CONSTRAINT lr_lease_epoch_positive CHECK (epoch >= 1),
    CONSTRAINT lr_lease_heartbeats_nonnegative CHECK (heartbeat_count >= 0),
    CONSTRAINT lr_lease_owner_nonempty CHECK (length(owner_id) BETWEEN 1 AND 200),
    CONSTRAINT lr_lease_cause_bounded CHECK (release_cause IS NULL OR length(release_cause) <= 200),
    CONSTRAINT lr_lease_cause_vocabulary CHECK (
        release_cause IS NULL OR release_cause IN ('paused','worker-released','human-interruption','terminated')
    ),
    CONSTRAINT lr_lease_release_shape CHECK (
        (released_at IS NULL AND release_cause IS NULL)
        OR (released_at IS NOT NULL AND release_cause IS NOT NULL)
    ),
    CONSTRAINT lr_lease_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT lr_lease_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE OR REPLACE FUNCTION executions.lr_lease_guards() RETURNS trigger AS $$ BEGIN IF NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id THEN RAISE EXCEPTION 'executions.execution_leases identity core is immutable (lease %)', OLD.execution_id; END IF; IF NEW.epoch < OLD.epoch THEN RAISE EXCEPTION 'execution % lease epoch must not regress (% -> %)', OLD.execution_id, OLD.epoch, NEW.epoch; END IF; IF NEW.heartbeat_count < OLD.heartbeat_count THEN RAISE EXCEPTION 'execution % lease heartbeat count must not regress (% -> %)', OLD.execution_id, OLD.heartbeat_count, NEW.heartbeat_count; END IF; IF NEW.epoch = OLD.epoch THEN IF NEW.owner_id <> OLD.owner_id THEN RAISE EXCEPTION 'execution % lease owner cannot change within epoch % (re-acquisition advances the epoch)', OLD.execution_id, OLD.epoch; END IF; IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'execution % lease is released; it can only be re-acquired at a new epoch', OLD.execution_id; END IF; IF NEW.released_at IS NULL AND NEW.expires_at < OLD.expires_at THEN RAISE EXCEPTION 'execution % lease expiry must not shorten within epoch %', OLD.execution_id, OLD.epoch; END IF; END IF; IF NEW.released_at IS NOT NULL AND NEW.released_at < OLD.acquired_at THEN RAISE EXCEPTION 'execution % lease release precedes acquisition', OLD.execution_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_lease_guards
    BEFORE UPDATE ON executions.execution_leases
    FOR EACH ROW EXECUTE FUNCTION executions.lr_lease_guards();

CREATE OR REPLACE FUNCTION executions.lr_lease_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'executions.execution_leases rows are never deleted (lease %)', OLD.execution_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_lease_no_delete_guard
    BEFORE DELETE ON executions.execution_leases
    FOR EACH ROW EXECUTE FUNCTION executions.lr_lease_no_delete();

-- A lease may only be acquired for a NON-TERMINAL execution (terminal
-- executions have no live mutable work to own).
CREATE OR REPLACE FUNCTION executions.lr_lease_insert_gate() RETURNS trigger AS $$ DECLARE terminal boolean; BEGIN SELECT status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED') INTO terminal FROM executions.executions WHERE id = NEW.execution_id AND application_id = NEW.application_id; IF terminal IS NULL THEN RAISE EXCEPTION 'execution % does not exist in application %', NEW.execution_id, NEW.application_id; END IF; IF terminal THEN RAISE EXCEPTION 'execution % is terminal; no lease may be acquired', NEW.execution_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_lease_insert_gate
    BEFORE INSERT ON executions.execution_leases
    FOR EACH ROW EXECUTE FUNCTION executions.lr_lease_insert_gate();

-- ---------------------------------------------------------------------------
-- Wake-ups: deterministic due-ordering by (earliest_wake_at, id); the
-- status machine scheduled -> applied | superseded; terminal statuses
-- are write-once immutable; rows never deleted.
-- ---------------------------------------------------------------------------

CREATE TABLE executions.execution_wakeups (
    id                    uuid PRIMARY KEY,
    application_id        uuid NOT NULL,
    tenant_id             uuid NOT NULL,
    execution_id          uuid NOT NULL,
    wake_key              text NOT NULL,
    cause                 text NOT NULL,
    earliest_wake_at      timestamptz NOT NULL,
    status                text NOT NULL,
    applied_at            timestamptz,
    applied_operation_key text,
    supersede_cause       text,
    created_at            timestamptz NOT NULL,
    updated_at            timestamptz NOT NULL,
    CONSTRAINT lr_wakeup_status_vocabulary CHECK (status IN ('scheduled','applied','superseded')),
    CONSTRAINT lr_wakeup_key_nonempty CHECK (length(wake_key) BETWEEN 1 AND 200),
    CONSTRAINT lr_wakeup_cause_bounded CHECK (length(cause) BETWEEN 1 AND 500),
    CONSTRAINT lr_wakeup_supersede_cause_bounded CHECK (supersede_cause IS NULL OR length(supersede_cause) <= 500),
    CONSTRAINT lr_wakeup_applied_requires_timestamp CHECK (status <> 'applied' OR applied_at IS NOT NULL),
    CONSTRAINT lr_wakeup_applied_requires_operation CHECK (status <> 'applied' OR applied_operation_key IS NOT NULL),
    CONSTRAINT lr_wakeup_scheduled_has_no_outcome CHECK (status <> 'scheduled' OR (applied_at IS NULL AND applied_operation_key IS NULL AND supersede_cause IS NULL)),
    CONSTRAINT lr_wakeup_key_unique UNIQUE (application_id, execution_id, wake_key),
    CONSTRAINT lr_wakeup_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT lr_wakeup_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

-- Deterministic due scan: (earliest_wake_at, id) over scheduled rows.
CREATE INDEX lr_wakeups_due_order
    ON executions.execution_wakeups (application_id, earliest_wake_at, id)
    WHERE status = 'scheduled';

CREATE INDEX lr_wakeups_by_execution
    ON executions.execution_wakeups (application_id, execution_id, created_at);

CREATE OR REPLACE FUNCTION executions.lr_wakeups_guards() RETURNS trigger AS $$ BEGIN IF NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.wake_key <> OLD.wake_key OR NEW.cause <> OLD.cause OR NEW.earliest_wake_at <> OLD.earliest_wake_at OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'executions.execution_wakeups identity core is immutable (wake-up %)', OLD.id; END IF; IF OLD.status IN ('applied','superseded') THEN RAISE EXCEPTION 'executions.execution_wakeups is terminal-immutable in state % (wake-up %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'scheduled' AND NEW.status IN ('applied','superseded','scheduled'))) THEN RAISE EXCEPTION 'wake-up % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; IF NEW.status = 'applied' AND (NEW.applied_at IS NULL OR NEW.applied_operation_key IS NULL OR NEW.supersede_cause IS NOT NULL) THEN RAISE EXCEPTION 'wake-up % applied requires applied_at + applied_operation_key and no supersede cause', OLD.id; END IF; IF NEW.status = 'superseded' AND NEW.applied_at IS NOT NULL THEN RAISE EXCEPTION 'wake-up % superseded cannot carry applied_at', OLD.id; END IF; IF NEW.status = 'scheduled' AND (NEW.applied_at IS NOT NULL OR NEW.applied_operation_key IS NOT NULL OR NEW.supersede_cause IS NOT NULL) THEN RAISE EXCEPTION 'wake-up % scheduled carries no outcome fields', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_wakeups_guards
    BEFORE UPDATE ON executions.execution_wakeups
    FOR EACH ROW EXECUTE FUNCTION executions.lr_wakeups_guards();

CREATE OR REPLACE FUNCTION executions.lr_wakeups_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'executions.execution_wakeups rows are never deleted (wake-up %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_wakeups_no_delete_guard
    BEFORE DELETE ON executions.execution_wakeups
    FOR EACH ROW EXECUTE FUNCTION executions.lr_wakeups_no_delete();

-- ---------------------------------------------------------------------------
-- The durable, recoverable long-running OPERATION state (the WORK-024
-- crash-safety standard). One row per governed long-running operation:
-- PENDING (claimed, not durably complete — a crash in the claim/
-- completion window leaves this; a retry MUST resume from the stage
-- checkpoint with the SAME stable key) -> COMPLETED (the durable
-- outcome exists; replays return it with no side effect) | FAILED (a
-- durably recorded terminal failure outcome — e.g. a journaled resume
-- re-admission denial).
-- ---------------------------------------------------------------------------

CREATE TABLE executions.execution_operations (
    id                  uuid PRIMARY KEY,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    execution_id        uuid NOT NULL,
    operation_kind      text NOT NULL,
    operation_key       text NOT NULL,
    request_fingerprint text NOT NULL,
    status              text NOT NULL,
    attempts            integer NOT NULL DEFAULT 1,
    stage               jsonb,
    failure_reason      text,
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    completed_at        timestamptz,
    CONSTRAINT lr_ops_kind_vocabulary CHECK (operation_kind IN ('checkpoint','pause','lease-acquire','lease-renew','lease-release','resume','interrupt','terminate','wakeup-schedule','wakeup-apply')),
    CONSTRAINT lr_ops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT lr_ops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT lr_ops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT lr_ops_fingerprint_nonempty CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT lr_ops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT lr_ops_stage_bounded CHECK (stage IS NULL OR pg_column_size(stage) <= 4096),
    CONSTRAINT lr_ops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT lr_ops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT lr_ops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT lr_ops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT lr_ops_key_unique UNIQUE (application_id, operation_key),
    CONSTRAINT lr_ops_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT lr_ops_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX lr_ops_execution_listing
    ON executions.execution_operations (application_id, execution_id, created_at);

CREATE INDEX lr_ops_pending_scan
    ON executions.execution_operations (application_id, status, updated_at)
    WHERE status = 'pending';

-- The identity core is write-once: application/tenant/execution binding,
-- the operation kind and key, the request fingerprint and the creation
-- timestamp never move.
CREATE OR REPLACE FUNCTION executions.lr_ops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'executions.execution_operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_ops_core_guard
    BEFORE UPDATE ON executions.execution_operations
    FOR EACH ROW EXECUTE FUNCTION executions.lr_ops_core_immutable();

-- The recoverable status machine: only PENDING may move (to COMPLETED
-- or FAILED, with the outcome fields set atomically); COMPLETED/FAILED
-- are terminal-immutable (stage/failure/reason/timestamps frozen);
-- attempts never regress; the stage checkpoint is writable only while
-- PENDING.
CREATE OR REPLACE FUNCTION executions.lr_ops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'executions.execution_operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) OR (OLD.status = 'completed' AND NEW.status <> 'completed') OR (OLD.status = 'failed' AND NEW.status <> 'failed') THEN RAISE EXCEPTION 'long-running operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_ops_lifecycle_guard
    BEFORE UPDATE ON executions.execution_operations
    FOR EACH ROW EXECUTE FUNCTION executions.lr_ops_lifecycle();

CREATE OR REPLACE FUNCTION executions.lr_ops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'executions.execution_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER lr_ops_no_delete_guard
    BEFORE DELETE ON executions.execution_operations
    FOR EACH ROW EXECUTE FUNCTION executions.lr_ops_no_delete();
