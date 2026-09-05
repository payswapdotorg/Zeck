-- WORK-044 — Asynchronous execution transport (D-03).
--
-- The durable PostgreSQL correlation/progress records for the
-- non-authoritative queue transport (`docs/DEPLOYMENT-ARCHITECTURE.md`
-- §10, `spec/work-orders/WORK-044.md`).
--
-- WHAT THIS SCHEMA IS:
--
--   * Transport/progress state ONLY. It never stores execution status:
--     the authoritative execution lifecycle remains in
--     executions.executions behind its single write path. The envelope
--     state vocabulary below (recorded/published/backlogged/completed/
--     dead-lettered) is deliberately DISJOINT from the execution state
--     vocabulary — there is no mapping between the two and no second
--     execution state machine (invariant: "Queue state is transport/
--     progress state only").
--
--   * The DURABLE HANDOFF RECORD: one envelope row per dispatch, with a
--     stable deterministic correlation key, committed BEFORE the
--     external queue message is published or relied upon. The transport
--     message carries only a correlation pointer; consumption resolves
--     the authoritative record from PostgreSQL — never from provider
--     state.
--
--   * Idempotency anchor: the correlation key is unique, so the same
--     logical dispatch cannot create two envelopes; the deterministic
--     consume operation key (applied_operation_key) records which
--     governed mutation was applied, so duplicate delivery converges
--     instead of duplicating authoritative effects.
--
--   * Append-only transport evidence: every publish/delivery/settle
--     attempt is an immutable transport_attempts row (bounded retry
--     observability); every bounded failure is an immutable
--     dead_letters row (explicit dead-letter condition).
--
-- Physical invariants (unrepresentable violations, house discipline):
--
--   * state is CHECK-bound to the exact 5-state transport vocabulary;
--   * terminal states (completed, dead-lettered) are PHYSICALLY
--     immutable and their terminal timestamps are shape-bound;
--   * non-terminal state changes must follow the legal transport
--     transition table (guard trigger below);
--   * applied-at markers are only representable on completed envelopes;
--   * transport_attempts and dead_letters are PHYSICALLY append-only;
--   * tenant scoping uses the composite-FK discipline of 0002/0003/0004;
--   * the execution binding is a real FK into executions.executions —
--     a correlation record for a nonexistent execution is
--     unrepresentable;
--   * replay lineage is FLAT: every replay references the ROOT
--     envelope (replay_of = root), and the replay ordinal is pinned
--     by the correlation key — chains are unrepresentable, so the
--     replay budget is countable in one query and bounded by policy.
--     Terminal rows are immutable, so replays create NEW envelopes
--     (never edit history; provenance is retained by reference).
--
-- Migration-runner statement rule (see runner.ts): statements split on
-- `;` at end of line — trigger function bodies are single lines with
-- no embedded `;` line endings.

CREATE SCHEMA queue_transport;

-- ---------------------------------------------------------------------------
-- Dispatch envelopes (the durable handoff / correlation records).
-- ---------------------------------------------------------------------------

CREATE TABLE queue_transport.dispatch_envelopes (
    id                    uuid PRIMARY KEY,
    correlation_key       text NOT NULL,
    purpose               text NOT NULL,
    tenant_id             uuid NOT NULL,
    application_id        uuid NOT NULL,
    execution_id          uuid NOT NULL,
    payload               jsonb NOT NULL,
    payload_digest        text NOT NULL,
    state                 text NOT NULL DEFAULT 'recorded',
    applied_at            timestamptz,
    applied_operation_key text,
    publish_attempts      integer NOT NULL DEFAULT 0,
    delivery_attempts     integer NOT NULL DEFAULT 0,
    replay_of             uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    consumed_at          timestamptz,
    dead_lettered_at      timestamptz,
    CONSTRAINT envelope_state_vocabulary
        CHECK (state IN ('recorded', 'published', 'backlogged', 'consumed', 'dead-lettered')),
    CONSTRAINT envelope_correlation_shape
        CHECK (correlation_key ~ '^execution-dispatch:[0-9a-f-]{36}(:replay-[0-9]+)?$'),
    CONSTRAINT envelope_purpose CHECK (purpose = 'execution-dispatch'),
    CONSTRAINT envelope_payload_shape CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT envelope_digest_shape CHECK (length(payload_digest) = 64),
    CONSTRAINT envelope_attempts_nonnegative
        CHECK (publish_attempts >= 0 AND delivery_attempts >= 0),
    CONSTRAINT envelope_correlation_unique UNIQUE (correlation_key),
    CONSTRAINT envelope_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT envelope_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT envelope_replay_fk
        FOREIGN KEY (replay_of) REFERENCES queue_transport.dispatch_envelopes (id)
);

CREATE INDEX envelopes_by_execution ON queue_transport.dispatch_envelopes (execution_id);
CREATE INDEX envelopes_by_state ON queue_transport.dispatch_envelopes (state, updated_at);
CREATE INDEX envelopes_backlog_scan
    ON queue_transport.dispatch_envelopes (updated_at)
    WHERE state IN ('recorded', 'backlogged');

-- Terminal-state shape binding: completed envelopes carry their
-- completion timestamp; dead-lettered ones carry the dead-letter time.
ALTER TABLE queue_transport.dispatch_envelopes
    ADD CONSTRAINT envelope_consumed_shape
    CHECK (
        (state = 'consumed' AND consumed_at IS NOT NULL AND dead_lettered_at IS NULL)
        OR (state = 'dead-lettered' AND dead_lettered_at IS NOT NULL AND consumed_at IS NULL)
        OR (state <> 'consumed' AND state <> 'dead-lettered' AND consumed_at IS NULL AND dead_lettered_at IS NULL)
    );

-- The applied markers exist only on consumed envelopes (an effect mark
-- without transport completion is unrepresentable; correctness of the
-- effect itself is owned by the executions idempotency ledger, this is
-- the transport-side observability of that fact).
ALTER TABLE queue_transport.dispatch_envelopes
    ADD CONSTRAINT envelope_applied_shape
    CHECK (
        (state = 'consumed' AND applied_at IS NOT NULL AND applied_operation_key IS NOT NULL)
        OR (state <> 'consumed' AND applied_at IS NULL AND applied_operation_key IS NULL)
    );

-- ---------------------------------------------------------------------------
-- Transport attempt evidence (append-only).
-- ---------------------------------------------------------------------------

CREATE TABLE queue_transport.transport_attempts (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    envelope_id   uuid NOT NULL,
    stage         text NOT NULL,
    attempt_no    integer NOT NULL,
    outcome       text NOT NULL,
    detail        text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attempt_stage_vocabulary CHECK (stage IN ('publish', 'delivery', 'settle')),
    CONSTRAINT attempt_outcome_vocabulary
        CHECK (outcome IN ('accepted', 'transient-failure', 'permanent-failure')),
    CONSTRAINT attempt_no_positive CHECK (attempt_no >= 1),
    CONSTRAINT attempt_detail_scrubbed CHECK (length(coalesce(detail, '')) <= 500),
    CONSTRAINT attempt_envelope_fk
        FOREIGN KEY (envelope_id) REFERENCES queue_transport.dispatch_envelopes (id)
);

CREATE INDEX attempts_by_envelope ON queue_transport.transport_attempts (envelope_id, id);

-- Physical append-only enforcement (single-line trigger bodies; runner rule).
CREATE OR REPLACE FUNCTION queue_transport.transport_attempts_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue_transport.transport_attempts is append-only (rejected % on attempt %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER transport_attempts_no_mutation
    BEFORE UPDATE OR DELETE ON queue_transport.transport_attempts
    FOR EACH ROW EXECUTE FUNCTION queue_transport.transport_attempts_append_only();

-- ---------------------------------------------------------------------------
-- Dead letters (the explicit bounded failure condition; append-only).
-- ---------------------------------------------------------------------------

CREATE TABLE queue_transport.dead_letters (
    id           uuid PRIMARY KEY,
    envelope_id  uuid NOT NULL,
    reason       text NOT NULL,
    attempts     integer NOT NULL,
    detail       text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dead_letter_reason_vocabulary
        CHECK (reason IN ('delivery-exhausted', 'publish-rejected', 'payload-mismatch', 'governed-rejection', 'unknown-envelope')),
    CONSTRAINT dead_letter_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT dead_letter_detail_scrubbed CHECK (length(coalesce(detail, '')) <= 500),
    CONSTRAINT dead_letter_envelope_fk
        FOREIGN KEY (envelope_id) REFERENCES queue_transport.dispatch_envelopes (id)
);

CREATE INDEX dead_letters_by_created ON queue_transport.dead_letters (created_at);

CREATE OR REPLACE FUNCTION queue_transport.dead_letters_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue_transport.dead_letters is append-only (rejected % on dead letter %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dead_letters_no_mutation
    BEFORE UPDATE OR DELETE ON queue_transport.dead_letters
    FOR EACH ROW EXECUTE FUNCTION queue_transport.dead_letters_append_only();

-- ---------------------------------------------------------------------------
-- The transport progress-state guard (no second state machine — the
-- ENVELOPE state machine is transport progress only, but its edges are
-- still physically pinned):
--   recorded     -> published | backlogged | dead-lettered
--   backlogged   -> published | dead-lettered
--   published    -> completed | dead-lettered
--   completed    -> (terminal; immutable)
--   dead-lettered-> (terminal; immutable)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION queue_transport.guard_envelope_progress() RETURNS trigger AS $$ BEGIN IF NEW.state = OLD.state THEN RETURN NEW; END IF; IF OLD.state = 'consumed' OR OLD.state = 'dead-lettered' THEN RAISE EXCEPTION 'queue_transport.dispatch_envelopes terminal state % is immutable', OLD.state; END IF; IF NOT ((OLD.state = 'recorded' AND NEW.state IN ('published', 'backlogged', 'dead-lettered')) OR (OLD.state = 'backlogged' AND NEW.state IN ('published', 'dead-lettered')) OR (OLD.state = 'published' AND NEW.state IN ('consumed', 'dead-lettered'))) THEN RAISE EXCEPTION 'illegal transport progress transition % -> %', OLD.state, NEW.state; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dispatch_envelopes_progress_guard
    BEFORE UPDATE OF state ON queue_transport.dispatch_envelopes
    FOR EACH ROW EXECUTE FUNCTION queue_transport.guard_envelope_progress();

-- Terminal immutability for the whole row (history rewrite is
-- unrepresentable; replay creates NEW envelopes, it never edits old ones).
CREATE OR REPLACE FUNCTION queue_transport.envelopes_terminal_immutable() RETURNS trigger AS $$ BEGIN IF OLD.state = 'consumed' OR OLD.state = 'dead-lettered' THEN RAISE EXCEPTION 'queue_transport.dispatch_envelopes row is terminal (%); replay creates a new envelope', OLD.state; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dispatch_envelopes_terminal_immutable
    BEFORE UPDATE ON queue_transport.dispatch_envelopes
    FOR EACH ROW WHEN (OLD.state = 'consumed' OR OLD.state = 'dead-lettered')
    EXECUTE FUNCTION queue_transport.envelopes_terminal_immutable();

CREATE OR REPLACE FUNCTION queue_transport.envelopes_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue_transport.dispatch_envelopes rows are never deleted (durable correlation history)'; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER dispatch_envelopes_no_delete
    BEFORE DELETE ON queue_transport.dispatch_envelopes
    FOR EACH ROW EXECUTE FUNCTION queue_transport.envelopes_no_delete();
