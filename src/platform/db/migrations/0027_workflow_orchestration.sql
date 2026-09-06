-- WORK-045 — Durable orchestration (D-04).
--
-- The durable PostgreSQL orchestration/progress records for the
-- non-authoritative workflow orchestration
-- (`docs/DEPLOYMENT-ARCHITECTURE.md` §10, `spec/work-orders/WORK-045.md`).
--
-- WHAT THIS SCHEMA IS:
--
--   * Orchestration/progress state ONLY. It never stores execution
--     status: the authoritative execution lifecycle remains in
--     executions.executions behind its single write path. The wait
--     state vocabulary below (recorded/deferred/armed/signaled/
--     settled/elapsed/superseded/abandoned) is deliberately DISJOINT
--     from the 14-state execution vocabulary (case-insensitively —
--     the D-03 lesson) — there is no mapping between the two and no
--     second execution state machine.
--
--   * The DURABLE CORRELATION RECORD: one wait row per logical
--     orchestration, with a stable deterministic wait key, committed
--     BEFORE any provider workflow instance is created or relied
--     upon. The provider instance receives only a correlation
--     pointer; every continuation path resolves the authoritative
--     record from PostgreSQL — never from provider state.
--
--   * Idempotency anchors: the wait key is unique (the same logical
--     wait cannot create two rows); the notification key is unique
--     per wait (duplicate delivery converges); EXACTLY ONE accepted
--     notification per wait is physically enforced (partial unique
--     index — first resolution wins, races converge); the
--     deterministic applied operation key records which governed
--     mutation was applied.
--
--   * Reference-only payloads: the pointer payload is ids/keys/
--     digests (jsonb object, byte-bounded by the engine); notification
--     payload BYTES are never stored — only their sha256 digest
--     (large artifacts and secret values never enter workflow
--     state).
--
--   * Bounded state by construction: attempts are policy-bounded;
--     retained notifications are bounded per wait (beyond the bound,
--     refused notifications only increment the durable folded
--     counter — the compaction fold, never row deletion); the
--     provider instance is terminated by the compaction run once
--     the wait is terminal (bounded provider state).
--
--   * Append-only orchestration evidence: every start/signal/
--     observe/terminate/effect attempt is an immutable attempts row;
--     every explicit bounded abandonment is an immutable
--     abandoned_waits row; notification rows are immutable except
--     their delivery facts (write-once delivery marker, monotonic
--     delivery attempts).
--
--   * Replacement lineage is FLAT: every replacement references the
--     ROOT wait (replacement_of = root, ordinal pinned by the wait
--     key) — chains are unrepresentable, so the replacement budget
--     is countable in one query and bounded by policy. Terminal
--     rows keep their terminal state forever; replacements create
--     NEW wait rows (never edit history).
--
-- Migration-runner statement rule (see runner.ts): statements split on
-- `;` at end of line — trigger function bodies are single lines with
-- no embedded `;` line endings.

CREATE SCHEMA workflow_orchestration;

-- ---------------------------------------------------------------------------
-- Orchestration waits (the durable correlation / handoff records).
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_orchestration.waits (
    id                        uuid PRIMARY KEY,
    wait_key                  text NOT NULL,
    tenant_id                 uuid NOT NULL,
    application_id            uuid NOT NULL,
    execution_id              uuid NOT NULL,
    wait_kind                 text NOT NULL,
    wait_ordinal              integer NOT NULL,
    replacement_of            uuid,
    pointer_payload           jsonb NOT NULL,
    payload_digest            text NOT NULL,
    deadline                  timestamptz,
    state                     text NOT NULL DEFAULT 'recorded',
    provider_instance_id      text,
    provider_observed_status  text,
    provider_observed_at      timestamptz,
    provider_terminated_at    timestamptz,
    start_attempts            integer NOT NULL DEFAULT 0,
    signal_delivery_attempts  integer NOT NULL DEFAULT 0,
    retained_notifications    integer NOT NULL DEFAULT 0,
    folded_notifications      integer NOT NULL DEFAULT 0,
    applied_operation_key     text,
    applied_at                timestamptz,
    settled_at                timestamptz,
    elapsed_at                timestamptz,
    superseded_at             timestamptz,
    abandoned_at              timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wait_state_vocabulary
        CHECK (state IN ('recorded', 'deferred', 'armed', 'signaled', 'settled', 'elapsed', 'superseded', 'abandoned')),
    CONSTRAINT wait_key_shape
        CHECK (wait_key ~ '^wait:[0-9a-f-]{36}:(timer|callback|approval):[0-9]+$'),
    CONSTRAINT wait_kind_vocabulary CHECK (wait_kind IN ('timer', 'callback', 'approval')),
    CONSTRAINT wait_payload_shape CHECK (jsonb_typeof(pointer_payload) = 'object'),
    CONSTRAINT wait_digest_shape CHECK (length(payload_digest) = 64),
    CONSTRAINT wait_ordinal_nonnegative CHECK (wait_ordinal >= 0),
    CONSTRAINT wait_root_shape
        CHECK ((replacement_of IS NULL AND wait_ordinal = 0) OR (replacement_of IS NOT NULL AND wait_ordinal > 0)),
    CONSTRAINT wait_attempts_nonnegative
        CHECK (start_attempts >= 0 AND signal_delivery_attempts >= 0 AND retained_notifications >= 0 AND folded_notifications >= 0),
    CONSTRAINT wait_observed_status_shape
        CHECK (provider_observed_status IS NULL OR provider_observed_status IN ('active', 'paused', 'errored', 'terminated', 'complete', 'unknown')),
    CONSTRAINT wait_instance_shape
        CHECK (
            (state IN ('recorded', 'deferred') AND provider_instance_id IS NULL)
            OR (state IN ('armed', 'signaled') AND provider_instance_id IS NOT NULL)
            OR (state IN ('settled', 'elapsed', 'superseded', 'abandoned'))
        ),
    CONSTRAINT wait_key_unique UNIQUE (wait_key),
    CONSTRAINT wait_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT wait_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT wait_replacement_fk
        FOREIGN KEY (replacement_of) REFERENCES workflow_orchestration.waits (id)
);

CREATE INDEX waits_by_execution ON workflow_orchestration.waits (execution_id);
CREATE INDEX waits_by_state ON workflow_orchestration.waits (state, updated_at);
CREATE INDEX waits_start_scan
    ON workflow_orchestration.waits (created_at)
    WHERE state IN ('recorded', 'deferred');
CREATE INDEX waits_deadline_scan
    ON workflow_orchestration.waits (deadline)
    WHERE state = 'armed';
CREATE INDEX waits_compaction_scan
    ON workflow_orchestration.waits (updated_at)
    WHERE state IN ('settled', 'elapsed', 'superseded', 'abandoned');

-- Terminal-state shape binding: each terminal state carries exactly
-- its own terminal timestamp; non-terminal states carry none.
ALTER TABLE workflow_orchestration.waits
    ADD CONSTRAINT wait_terminal_shape
    CHECK (
        (state = 'settled' AND settled_at IS NOT NULL AND elapsed_at IS NULL AND superseded_at IS NULL AND abandoned_at IS NULL)
        OR (state = 'elapsed' AND elapsed_at IS NOT NULL AND settled_at IS NULL AND superseded_at IS NULL AND abandoned_at IS NULL)
        OR (state = 'superseded' AND superseded_at IS NOT NULL AND settled_at IS NULL AND elapsed_at IS NULL AND abandoned_at IS NULL)
        OR (state = 'abandoned' AND abandoned_at IS NOT NULL AND settled_at IS NULL AND elapsed_at IS NULL AND superseded_at IS NULL)
        OR (state IN ('recorded', 'deferred', 'armed', 'signaled') AND settled_at IS NULL AND elapsed_at IS NULL AND superseded_at IS NULL AND abandoned_at IS NULL)
    );

-- The applied markers exist only on effect-settled waits (settled =
-- notification resolution applied; elapsed = governed expiration
-- applied). Superseded/abandoned waits never carry an effect marker:
-- no governed mutation ever happened for them.
ALTER TABLE workflow_orchestration.waits
    ADD CONSTRAINT wait_applied_shape
    CHECK (
        (state IN ('settled', 'elapsed') AND applied_at IS NOT NULL AND applied_operation_key IS NOT NULL)
        OR (state NOT IN ('settled', 'elapsed') AND applied_at IS NULL AND applied_operation_key IS NULL)
    );

-- ---------------------------------------------------------------------------
-- Intake notifications (callback / approval evidence; digest-only).
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_orchestration.notifications (
    id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wait_id                    uuid NOT NULL,
    notification_key           text NOT NULL,
    kind                       text NOT NULL,
    decision                   text,
    approver_id                text,
    payload_digest             text NOT NULL,
    outcome                    text NOT NULL,
    detail                     text,
    provider_delivered_at      timestamptz,
    provider_delivery_attempts integer NOT NULL DEFAULT 0,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_kind_vocabulary CHECK (kind IN ('callback', 'approval')),
    CONSTRAINT notification_decision_shape
        CHECK (
            (kind = 'callback' AND decision IS NULL)
            OR (kind = 'approval' AND decision IS NULL AND approver_id IS NULL)
            OR (kind = 'approval' AND decision IN ('approve', 'reject') AND approver_id IS NOT NULL AND length(approver_id) > 0)
        ),
    CONSTRAINT notification_outcome_vocabulary
        CHECK (outcome IN ('accepted', 'duplicate', 'refused-stale', 'refused-conflict', 'refused-scope', 'refused-folded')),
    CONSTRAINT notification_digest_shape CHECK (length(payload_digest) = 64),
    CONSTRAINT notification_delivery_attempts_nonnegative CHECK (provider_delivery_attempts >= 0),
    CONSTRAINT notification_detail_scrubbed CHECK (length(coalesce(detail, '')) <= 500),
    CONSTRAINT notification_key_unique UNIQUE (wait_id, notification_key),
    CONSTRAINT notification_wait_fk
        FOREIGN KEY (wait_id) REFERENCES workflow_orchestration.waits (id)
);

-- FIRST RESOLUTION WINS, PHYSICALLY: exactly one accepted
-- notification per wait. A racing second accepted insert fails here
-- and converges as a duplicate (the store maps the unique violation).
CREATE UNIQUE INDEX one_accepted_notification_per_wait
    ON workflow_orchestration.notifications (wait_id)
    WHERE outcome = 'accepted';

CREATE INDEX notifications_by_wait ON workflow_orchestration.notifications (wait_id, id);
CREATE INDEX notifications_pending_delivery
    ON workflow_orchestration.notifications (id)
    WHERE outcome = 'accepted' AND provider_delivered_at IS NULL;

-- Notification rows are immutable except their DELIVERY FACTS (the
-- write-once delivered marker and the monotonic delivery attempts).
CREATE OR REPLACE FUNCTION workflow_orchestration.notifications_immutable() RETURNS trigger AS $$ BEGIN IF NEW.wait_id <> OLD.wait_id OR NEW.notification_key <> OLD.notification_key OR NEW.kind <> OLD.kind OR NEW.decision IS DISTINCT FROM OLD.decision OR NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.payload_digest <> OLD.payload_digest OR NEW.outcome <> OLD.outcome OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'workflow_orchestration.notifications is immutable except delivery facts (rejected %)', TG_OP; END IF; IF NEW.provider_delivery_attempts < OLD.provider_delivery_attempts THEN RAISE EXCEPTION 'notification delivery attempts cannot decrease'; END IF; IF OLD.provider_delivered_at IS NOT NULL AND NEW.provider_delivered_at IS DISTINCT FROM OLD.provider_delivered_at THEN RAISE EXCEPTION 'notification delivery is write-once'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_delivery_facts_only
    BEFORE UPDATE ON workflow_orchestration.notifications
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.notifications_immutable();

CREATE OR REPLACE FUNCTION workflow_orchestration.notifications_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'workflow_orchestration.notifications rows are never deleted (durable intake evidence; compaction is the folded counter, never row deletion)'; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_no_delete
    BEFORE DELETE ON workflow_orchestration.notifications
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.notifications_no_delete();

-- ---------------------------------------------------------------------------
-- Orchestration attempt evidence (append-only).
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_orchestration.attempts (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wait_id     uuid NOT NULL,
    stage       text NOT NULL,
    attempt_no  integer NOT NULL,
    outcome     text NOT NULL,
    detail      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attempt_stage_vocabulary CHECK (stage IN ('start', 'signal', 'observe', 'terminate', 'effect')),
    CONSTRAINT attempt_outcome_vocabulary
        CHECK (outcome IN ('accepted', 'transient-failure', 'permanent-failure')),
    CONSTRAINT attempt_no_positive CHECK (attempt_no >= 1),
    CONSTRAINT attempt_detail_scrubbed CHECK (length(coalesce(detail, '')) <= 500),
    CONSTRAINT attempt_wait_fk
        FOREIGN KEY (wait_id) REFERENCES workflow_orchestration.waits (id)
);

CREATE INDEX attempts_by_wait ON workflow_orchestration.attempts (wait_id, id);

CREATE OR REPLACE FUNCTION workflow_orchestration.attempts_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'workflow_orchestration.attempts is append-only (rejected % on attempt %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER attempts_no_mutation
    BEFORE UPDATE OR DELETE ON workflow_orchestration.attempts
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.attempts_append_only();

-- ---------------------------------------------------------------------------
-- Explicit bounded abandonments (the dead-letter analogue; append-only).
-- ---------------------------------------------------------------------------

CREATE TABLE workflow_orchestration.abandoned_waits (
    id          uuid PRIMARY KEY,
    wait_id     uuid NOT NULL,
    reason      text NOT NULL,
    detail      text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT abandoned_reason_vocabulary
        CHECK (reason IN ('start-rejected', 'effect-exhausted', 'governed-rejection', 'provider-reported-errored', 'provider-reported-terminated', 'replaced')),
    CONSTRAINT abandoned_detail_scrubbed CHECK (length(coalesce(detail, '')) <= 500),
    CONSTRAINT abandoned_wait_fk
        FOREIGN KEY (wait_id) REFERENCES workflow_orchestration.waits (id)
);

CREATE INDEX abandoned_by_created ON workflow_orchestration.abandoned_waits (created_at);

CREATE OR REPLACE FUNCTION workflow_orchestration.abandoned_waits_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'workflow_orchestration.abandoned_waits is append-only (rejected % on abandonment %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER abandoned_waits_no_mutation
    BEFORE UPDATE OR DELETE ON workflow_orchestration.abandoned_waits
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.abandoned_waits_append_only();

-- ---------------------------------------------------------------------------
-- The orchestration progress-state guard (no second state machine —
-- the WAIT state machine is orchestration progress only, but its
-- edges are still physically pinned):
--   recorded  -> deferred | armed | abandoned
--   deferred  -> armed | abandoned
--   armed     -> signaled | elapsed | superseded | abandoned
--   signaled  -> settled | superseded | abandoned
--   settled   -> (terminal)
--   elapsed   -> (terminal)
--   superseded-> (terminal)
--   abandoned -> (terminal)
-- Same-state updates (observation/compaction/counter facts) pass.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_orchestration.guard_wait_progress() RETURNS trigger AS $$ BEGIN IF NEW.state = OLD.state THEN RETURN NEW; END IF; IF OLD.state IN ('settled', 'elapsed', 'superseded', 'abandoned') THEN RAISE EXCEPTION 'workflow_orchestration.waits terminal state % is immutable', OLD.state; END IF; IF NOT ((OLD.state = 'recorded' AND NEW.state IN ('deferred', 'armed', 'abandoned')) OR (OLD.state = 'deferred' AND NEW.state IN ('armed', 'abandoned')) OR (OLD.state = 'armed' AND NEW.state IN ('signaled', 'elapsed', 'superseded', 'abandoned')) OR (OLD.state = 'signaled' AND NEW.state IN ('settled', 'superseded', 'abandoned'))) THEN RAISE EXCEPTION 'illegal orchestration progress transition % -> %', OLD.state, NEW.state; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER waits_progress_guard
    BEFORE UPDATE OF state ON workflow_orchestration.waits
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.guard_wait_progress();

-- Terminal-row discipline: once terminal, only the provider
-- observation/compaction columns, the signal-delivery fact counters
-- (recovery re-delivers accepted notifications after settlement)
-- and updated_at may change — the resolution history is never
-- rewritten.
CREATE OR REPLACE FUNCTION workflow_orchestration.waits_terminal_discipline() RETURNS trigger AS $$ BEGIN IF OLD.state IN ('settled', 'elapsed', 'superseded', 'abandoned') THEN IF NEW.wait_key <> OLD.wait_key OR NEW.tenant_id <> OLD.tenant_id OR NEW.application_id <> OLD.application_id OR NEW.execution_id <> OLD.execution_id OR NEW.wait_kind <> OLD.wait_kind OR NEW.wait_ordinal <> OLD.wait_ordinal OR NEW.replacement_of IS DISTINCT FROM OLD.replacement_of OR NEW.pointer_payload <> OLD.pointer_payload OR NEW.payload_digest <> OLD.payload_digest OR NEW.deadline IS DISTINCT FROM OLD.deadline OR NEW.state <> OLD.state OR NEW.start_attempts <> OLD.start_attempts OR NEW.retained_notifications <> OLD.retained_notifications OR NEW.folded_notifications <> OLD.folded_notifications OR NEW.applied_operation_key IS DISTINCT FROM OLD.applied_operation_key OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.elapsed_at IS DISTINCT FROM OLD.elapsed_at OR NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'workflow_orchestration.waits row is terminal (%); replacement creates a new wait, compaction only touches provider columns', OLD.state; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER waits_terminal_discipline
    BEFORE UPDATE ON workflow_orchestration.waits
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.waits_terminal_discipline();

CREATE OR REPLACE FUNCTION workflow_orchestration.waits_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'workflow_orchestration.waits rows are never deleted (durable correlation history)'; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER waits_no_delete
    BEFORE DELETE ON workflow_orchestration.waits
    FOR EACH ROW EXECUTE FUNCTION workflow_orchestration.waits_no_delete();
