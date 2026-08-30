-- WORK-006 — Execution identity, lifecycle and event core.
--
-- The authoritative durable Execution state machine and its append-only
-- event ledger (`spec/contracts.md`, `IMPLEMENTATION.md` §4–§6).
--
-- Physical invariants enforced here (mirroring the WORK-003/0004 discipline
-- of making violations UNREPRESENTABLE, not merely discouraged):
--
--   * executions.executions.status is CHECK-bound to the exact 14-state
--     vocabulary of the frozen transition table — an unknown state cannot
--     be stored;
--   * COMPLETED is physically impossible without a non-empty
--     verification_refs binding (`executions_completion_requires_verification`)
--     AND the binding shape is pinned (refs exist iff status is COMPLETED);
--     the `executions_verification_refs_durable` trigger additionally
--     requires every referenced id to be a durable row of
--     executions.verification_results for THIS execution — no provider-
--     success or planner-success shortcut to completion is committable,
--     even with every service-level guard removed;
--   * terminal states (COMPLETED/FAILED/CANCELLED/EXPIRED) are PHYSICALLY
--     immutable: the forward-only trigger rejects any UPDATE of a terminal
--     row and every DELETE — no resurrection, no history rewrite;
--   * every UPDATE of an execution row must append exactly ONE new ledger
--     envelope (`last_event_sequence` advances by exactly one AND a row
--     with that sequence exists in executions.execution_events in the same
--     transaction) — a status write without its event is unrepresentable,
--     which is the physical half of the "single write path" guarantee;
--   * executions.execution_events is PHYSICALLY append-only (UPDATE and
--     DELETE rejected by trigger) and PHYSICALLY gapless per execution
--     (an inserted sequence must equal max(sequence)+1 for that execution;
--     duplicates additionally die on the unique index);
--   * executions.verification_results is PHYSICALLY append-only
--     (verification evidence is immutable once recorded);
--   * tenant scoping uses composite FKs like migrations 0002/0003:
--     (application_id, tenant_id) -> applications.applications and
--     (environment_id, application_id) -> applications.environments, so a
--     cross-tenant or cross-application binding is unrepresentable.
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE SCHEMA executions;

-- Composite-FK anti-ambiguity for the optional environment binding: the
-- environment id alone is already unique (PRIMARY KEY); this constraint
-- exists so executions can reference (environment_id, application_id) and a
-- cross-application environment id is unrepresentable.
ALTER TABLE applications.environments
    ADD CONSTRAINT environments_id_application_unique UNIQUE (id, application_id);

-- ---------------------------------------------------------------------------
-- Executions (owned by the executions module; the primary public AI-work
-- abstraction). One row per logical execution; the row is CREATED exactly
-- once (UUIDv7 ExecutionId, request-idempotent arbitration in the service)
-- together with its sequence-1 creation envelope, in one transaction.
--
-- `last_event_sequence` tracks the highest committed per-execution event
-- sequence; the trigger below pins the row/event coupling. Terminal
-- timestamps are shape-bound to their terminal state.
-- ---------------------------------------------------------------------------

CREATE TABLE executions.executions (
    id                   uuid PRIMARY KEY,
    application_id       uuid NOT NULL,
    tenant_id            uuid NOT NULL,
    environment_id       uuid,
    user_id              text NOT NULL DEFAULT '',
    status               text NOT NULL DEFAULT 'CREATED',
    task                 jsonb NOT NULL,
    input_artifacts      jsonb NOT NULL DEFAULT '[]'::jsonb,
    execution_constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
    user_metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_fingerprint  text NOT NULL,
    last_event_sequence  integer NOT NULL DEFAULT 1,
    verification_refs    jsonb NOT NULL DEFAULT '[]'::jsonb,
    completed_at         timestamptz,
    failed_at            timestamptz,
    cancelled_at         timestamptz,
    expired_at           timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT executions_status_vocabulary CHECK (
        status IN ('CREATED', 'AUTHORIZED', 'PLANNING', 'QUEUED', 'RUNNING',
                   'WAITING_TOOL', 'WAITING_USER', 'WAITING_HUMAN', 'VERIFYING',
                   'REPLANNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')
    ),
    CONSTRAINT executions_sequence_positive CHECK (last_event_sequence >= 1),
    CONSTRAINT executions_task_shape CHECK (jsonb_typeof(task) = 'object'),
    CONSTRAINT executions_artifacts_shape CHECK (jsonb_typeof(input_artifacts) = 'array'),
    -- COMPLETED is produced ONLY by the verify-pass edge and MUST carry at
    -- least one durable verification result reference (spec/contracts.md).
    CONSTRAINT executions_completion_requires_verification CHECK (
        (status <> 'COMPLETED') OR (jsonb_array_length(verification_refs) >= 1)
    ),
    -- The binding exists iff the execution completed: refs on a non-terminal
    -- row are unrepresentable, completion without refs is unrepresentable.
    CONSTRAINT executions_verification_binding_shape CHECK (
        (status = 'COMPLETED' AND verification_refs <> '[]'::jsonb)
        OR (status <> 'COMPLETED' AND verification_refs = '[]'::jsonb)
    ),
    -- Terminal timestamps: exactly one, matching the terminal state.
    CONSTRAINT executions_terminal_timestamps CHECK (
        (status = 'COMPLETED' AND completed_at IS NOT NULL AND failed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL)
        OR (status = 'FAILED' AND failed_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL)
        OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND expired_at IS NULL)
        OR (status = 'EXPIRED' AND expired_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND cancelled_at IS NULL)
        OR (status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED') AND completed_at IS NULL AND failed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL)
    ),
    CONSTRAINT executions_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT executions_environment_fk
        FOREIGN KEY (environment_id, application_id)
        REFERENCES applications.environments (id, application_id),
    -- Composite identity for child-table references (events/verification
    -- results bind to THIS application's execution — cross-application
    -- binding unrepresentable).
    CONSTRAINT executions_id_application_unique UNIQUE (id, application_id)
);

CREATE INDEX executions_by_application ON executions.executions (application_id, created_at);

-- ---------------------------------------------------------------------------
-- Durable verification results (owned by the executions module for
-- WORK-006): every record a verify outcome durably; completion binds to at
-- least one of them. The verification AUTHORITY (evaluators, quality gates)
-- is WORK-013 — this table is the durable evidence record the lifecycle
-- binds to, not an evaluator. PHYSICALLY append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE executions.verification_results (
    id             uuid PRIMARY KEY,
    execution_id   uuid NOT NULL,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    criterion_id   text NOT NULL,
    strategy       text NOT NULL,
    status         text NOT NULL,
    evidence       jsonb NOT NULL DEFAULT '[]'::jsonb,
    recorded_by    text NOT NULL,
    recorded_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT verification_status CHECK (status IN ('PASS', 'FAIL', 'INCONCLUSIVE')),
    CONSTRAINT verification_criterion_nonempty CHECK (length(criterion_id) BETWEEN 1 AND 200),
    CONSTRAINT verification_strategy_nonempty CHECK (length(strategy) BETWEEN 1 AND 200),
    CONSTRAINT verification_recorded_by_nonempty CHECK (length(recorded_by) BETWEEN 1 AND 200),
    CONSTRAINT verification_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT verification_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

-- ---------------------------------------------------------------------------
-- EventEnvelope ledger (owned by the executions module; IMPLEMENTATION.md
-- §4): one append-only row per committed transition (sequence 1 = creation).
-- Per-execution sequence is UNIQUE and gapless (trigger + unique index).
-- Provenance columns are NOT NULL: every envelope carries the durable
-- who/what/why chain (command, actor, cause, reference) satisfying the
-- EXECUTION-PROVENANCE contract.
-- ---------------------------------------------------------------------------

CREATE TABLE executions.execution_events (
    id              uuid PRIMARY KEY,
    execution_id    uuid NOT NULL,
    application_id  uuid NOT NULL,
    tenant_id       uuid NOT NULL,
    sequence        integer NOT NULL,
    type            text NOT NULL,
    command         text NOT NULL,
    actor           jsonb NOT NULL,
    cause           text,
    reference       jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    producer_module text NOT NULL DEFAULT 'executions',
    schema_version  integer NOT NULL DEFAULT 1,
    CONSTRAINT events_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT events_producer CHECK (producer_module = 'executions'),
    CONSTRAINT events_schema_version CHECK (schema_version >= 1),
    CONSTRAINT events_type_nonempty CHECK (length(type) BETWEEN 1 AND 100),
    CONSTRAINT events_command_nonempty CHECK (length(command) BETWEEN 1 AND 50),
    CONSTRAINT events_actor_shape CHECK (jsonb_typeof(actor) = 'object'),
    CONSTRAINT events_sequence_unique UNIQUE (execution_id, sequence),
    CONSTRAINT events_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT events_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX events_by_execution ON executions.execution_events (execution_id, sequence);

-- Physical append-only enforcement (single-line trigger bodies; runner rule).
CREATE OR REPLACE FUNCTION executions.execution_events_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'executions.execution_events is append-only (rejected % on event %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER execution_events_no_mutation
    BEFORE UPDATE OR DELETE ON executions.execution_events
    FOR EACH ROW EXECUTE FUNCTION executions.execution_events_append_only();

-- Physical gapless sequence: an insert must take the NEXT per-execution
-- sequence (max + 1); a gap or a replayed/duplicate sequence is rejected
-- before it commits (duplicates additionally die on events_sequence_unique).
CREATE OR REPLACE FUNCTION executions.events_gapless_sequence() RETURNS trigger AS $$ DECLARE expected integer; BEGIN SELECT COALESCE(MAX(sequence), 0) + 1 INTO expected FROM executions.execution_events WHERE execution_id = NEW.execution_id; IF NEW.sequence IS DISTINCT FROM expected THEN RAISE EXCEPTION 'execution_events sequence must be gapless per execution (execution % expected sequence %, got %)', NEW.execution_id, expected, NEW.sequence; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER execution_events_gapless_sequence
    BEFORE INSERT ON executions.execution_events
    FOR EACH ROW EXECUTE FUNCTION executions.events_gapless_sequence();

CREATE OR REPLACE FUNCTION executions.verification_results_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'executions.verification_results is append-only (rejected % on result %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER verification_results_no_mutation
    BEFORE UPDATE OR DELETE ON executions.verification_results
    FOR EACH ROW EXECUTE FUNCTION executions.verification_results_append_only();

-- Completion binding: non-empty verification_refs must reference durable
-- verification results OF THIS EXECUTION — a dangling or cross-execution
-- reference is unrepresentable.
CREATE OR REPLACE FUNCTION executions.verification_refs_durable() RETURNS trigger AS $$ BEGIN IF NEW.verification_refs IS NOT NULL AND NEW.verification_refs <> '[]'::jsonb THEN IF NOT EXISTS (SELECT 1 FROM executions.verification_results r WHERE r.execution_id = NEW.id AND r.id::text IN (SELECT jsonb_array_elements_text(NEW.verification_refs))) THEN RAISE EXCEPTION 'execution % verification binding references no durable verification result of this execution', NEW.id; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER executions_verification_refs_durable
    BEFORE INSERT OR UPDATE OF verification_refs ON executions.executions
    FOR EACH ROW EXECUTE FUNCTION executions.verification_refs_durable();

-- Forward-only, event-coupled execution rows:
--   * rows are never deleted;
--   * terminal rows are immutable (no resurrection/branching);
--   * every UPDATE must advance last_event_sequence by EXACTLY one and a
--     ledger envelope with that sequence must exist for this execution
--     (visible in-transaction) — a status write without its event, a
--     multi-step jump and a no-op rewind are all unrepresentable.
CREATE OR REPLACE FUNCTION executions.executions_forward_only() RETURNS trigger AS $$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'executions.executions rows are never deleted (execution %)', OLD.id; END IF; IF OLD.status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED') THEN RAISE EXCEPTION 'executions.executions is terminal-immutable in state % (execution %)', OLD.status, OLD.id; END IF; IF NEW.last_event_sequence IS DISTINCT FROM OLD.last_event_sequence + 1 THEN RAISE EXCEPTION 'execution % writes must append exactly one event (expected sequence %, got %)', OLD.id, OLD.last_event_sequence + 1, NEW.last_event_sequence; END IF; IF NOT EXISTS (SELECT 1 FROM executions.execution_events e WHERE e.execution_id = NEW.id AND e.sequence = NEW.last_event_sequence) THEN RAISE EXCEPTION 'execution % update has no matching ledger envelope at sequence %', NEW.id, NEW.last_event_sequence; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER executions_forward_only
    BEFORE UPDATE OR DELETE ON executions.executions
    FOR EACH ROW EXECUTE FUNCTION executions.executions_forward_only();
