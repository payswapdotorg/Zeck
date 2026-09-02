-- WORK-024 — Voice and Realtime Agent Deployment (MOD-005/006/007).
--
-- The durable state of the realtime voice fabric: REALTIME SESSIONS/CALLS
-- bound to tenant + application + deployment + PINNED deployment plan
-- version + Execution identity (MOD-006), and the APPEND-ONLY realtime
-- channel journal whose inbound rows ARE the idempotency ledger for
-- duplicate inbound events (upstream-supplied event ids or deterministic
-- substitutes — the work order's implementation requirement).
--
-- AUTHORITY PRESERVATION (the frozen invariants + the WORK-024 work order):
--   * a realtime session MAPS TO a governed Execution: execution_id is a
--     REFERENCE (uuid, no FK into executions state) — the session never
--     writes execution status and never becomes a second execution or
--     event authority; the canonical turn/interruption/transfer/failure
--     provenance rides the executions EventEnvelope ledger through the
--     executions public recordStepEvent seam (executions vocabulary
--     "agent-session-started" / "agent-action-recorded" /
--     "agent-session-completed"); this journal records CHANNEL/session
--     state + idempotency + the ledger-sequence linkage
--     (ledger_sequence), never a second event authority;
--   * deployment version pinning: the session's pinned plan identity is
--     IMMUTABLE for the session's lifetime (physical trigger) — promote/
--     rollback on the deployment never rewrites a live session's pin and
--     never touches prior Execution identity;
--   * provider neutrality (MOD-005): channel_kind is the neutral
--     deployment vocabulary; channel_session_ref is the rail's OPAQUE
--     session reference; rail capability ids arrive only as neutral
--     strings; vendor identifiers are structurally absent;
--   * raw media stays OUT of this ledger: event rows carry bounded
--     payload previews and ARTIFACT REFERENCES (payload_ref), never
--     media blobs (CHECK-bounded);
--   * cross-module references are READ-ONLY bindings:
--     (application_id, tenant_id) -> applications.applications;
--     deployment_id -> deployments.deployments (the fabric binding);
--     execution_id -> executions.executions by UUID WITHOUT FK (the
--     executions module's idempotent identity is authoritative; the
--     reference records provenance linkage only).
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * realtime_sessions: the identity core (ids, deployment binding,
--     pinned plan version, execution id, creation fingerprint, channel
--     kind, created_at) is immutable on every UPDATE path; only the
--     guarded status/channel-reference/epoch/closure fields may move;
--     the channel epoch is monotonic (reattach increments; a stale
--     callback's (ref, epoch) can never match again); terminal statuses
--     (closed/failed/transferred) are fully immutable; rows never
--     deleted;
--   * realtime_events: APPEND-ONLY (no UPDATE/DELETE), identity-ordered
--     (event_seq), and the inbound idempotency ledger — UNIQUE
--     (application_id, session_id, event_key) arbitrates duplicate
--     inbound events (a duplicate converges on the committed row; a
--     same-key/different-body insert fails closed);
--   * realtime_operations (the architect's crash-safety correction for
--     PR #46): the DURABLE, RECOVERABLE OPERATION STATE — one row per
--     governed rail-side-effect operation with the PENDING ->
--     COMPLETED|FAILED machine. UNIQUE (application_id, operation_key)
--     arbitrates the durable claim; `attempts` is the retry ledger
--     (monotonic); the checkpoint is bounded jsonb and writable only
--     while PENDING; COMPLETED/FAILED are fully immutable and
--     completion-timestamped; rows are never deleted. session_id is a
--     PROVENANCE REFERENCE WITHOUT FK — a session-start operation row
--     is durably claimed BEFORE its session row exists (that ordering
--     is exactly the crash window this ledger closes);
--   * inbound event freshness: an inbound row's (channel_session_ref,
--     channel_epoch) must match the session's CURRENT values at insert
--     time (trigger) — a stale callback cannot mutate the wrong session
--     physically;
--   * the session status machine is the frozen realtime vocabulary:
--     live -> reconnecting/closed/failed/transferred;
--     reconnecting -> live/closed/failed; terminal statuses immutable.
--
-- Migration-version discipline (the collision rule, parallel wave):
-- the live inventory at authoring time is 0001..0014 and 0016
-- (0016_opportunity_analysis.sql, merged WORK-022). 0015 is BURNED
-- (WORK-019's owned number; its file is absent from the base tree by
-- the documented wave-1 reconciliation anomaly — never reused). The
-- wave-2 pre-assigned numbers by dispatch order: sibling WORK-020
-- claims 0017 (its file is NOT in this branch), and WORK-024 claims
-- 0018 (THIS migration). No other unmerged Work Order claims 0018.

CREATE TABLE deployments.realtime_sessions (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    deployment_id  uuid NOT NULL,
    pinned_plan_id text NOT NULL,
    pinned_plan_version integer NOT NULL,
    execution_id   uuid NOT NULL,
    channel_kind   text NOT NULL,
    channel_session_ref text NOT NULL,
    channel_epoch  integer NOT NULL,
    caller_ref     text,
    status         text NOT NULL,
    creation_fingerprint text NOT NULL,
    created_by     uuid NOT NULL,
    idempotency_key text NOT NULL,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    closed_at      timestamptz,
    CONSTRAINT rt_sessions_channel_vocabulary CHECK (channel_kind IN ('web','in-app','telephony')),
    CONSTRAINT rt_sessions_status_vocabulary CHECK (status IN ('live','reconnecting','closed','failed','transferred')),
    CONSTRAINT rt_sessions_epoch_positive CHECK (channel_epoch >= 1),
    CONSTRAINT rt_sessions_plan_version_positive CHECK (pinned_plan_version >= 1),
    CONSTRAINT rt_sessions_fingerprint_nonempty CHECK (length(creation_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT rt_sessions_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT rt_sessions_caller_bounded CHECK (caller_ref IS NULL OR length(caller_ref) <= 200),
    CONSTRAINT rt_sessions_ref_bounded CHECK (length(channel_session_ref) BETWEEN 1 AND 200),
    CONSTRAINT rt_sessions_key_unique UNIQUE (application_id, idempotency_key),
    CONSTRAINT rt_sessions_channel_unique UNIQUE (application_id, channel_session_ref, channel_epoch),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT rt_sessions_deployment_fk FOREIGN KEY (deployment_id)
        REFERENCES deployments.deployments (id)
);

CREATE INDEX rt_sessions_scope_listing
    ON deployments.realtime_sessions (application_id, deployment_id, created_at, id);

-- The identity core is write-once: tenant/deployment binding, the PINNED
-- plan version (version pinning — MOD-007/AC7), the Execution identity
-- binding and the channel kind never move after creation.
CREATE OR REPLACE FUNCTION deployments.rt_sessions_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.pinned_plan_id <> OLD.pinned_plan_id OR NEW.pinned_plan_version <> OLD.pinned_plan_version OR NEW.execution_id <> OLD.execution_id OR NEW.channel_kind <> OLD.channel_kind OR NEW.creation_fingerprint <> OLD.creation_fingerprint OR NEW.created_by <> OLD.created_by OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.realtime_sessions identity core is immutable (session % — the pinned plan version and execution identity never move)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_sessions_core_guard
    BEFORE UPDATE ON deployments.realtime_sessions
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_sessions_core_immutable();

-- The frozen realtime session status machine + monotonic channel epoch
-- (reattach: a strictly NEW channel reference at epoch+1; a stale
-- callback's (ref, epoch) can never match a live session again).
CREATE OR REPLACE FUNCTION deployments.rt_sessions_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('closed','failed','transferred') THEN RAISE EXCEPTION 'deployments.realtime_sessions is terminal-immutable in state % (session %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'live' AND NEW.status IN ('live','reconnecting','closed','failed','transferred')) OR (OLD.status = 'reconnecting' AND NEW.status IN ('reconnecting','live','closed','failed'))) THEN RAISE EXCEPTION 'realtime session % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; IF NEW.channel_epoch < OLD.channel_epoch THEN RAISE EXCEPTION 'realtime session % channel epoch must not regress (% -> %)', OLD.id, OLD.channel_epoch, NEW.channel_epoch; END IF; IF NEW.channel_epoch = OLD.channel_epoch AND NEW.channel_session_ref <> OLD.channel_session_ref THEN RAISE EXCEPTION 'realtime session % cannot change channel reference without advancing the epoch', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_sessions_lifecycle_guard
    BEFORE UPDATE ON deployments.realtime_sessions
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_sessions_lifecycle();

CREATE OR REPLACE FUNCTION deployments.rt_sessions_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.realtime_sessions rows are never deleted (session %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_sessions_no_delete_guard
    BEFORE DELETE ON deployments.realtime_sessions
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_sessions_no_delete();

-- ---------------------------------------------------------------------------
-- The append-only realtime channel journal (MOD-006 + the inbound
-- idempotency ledger of the work order's implementation requirements).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.realtime_events (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    session_id    uuid NOT NULL,
    deployment_id uuid NOT NULL,
    kind          text NOT NULL,
    direction     text NOT NULL,
    event_key     text NOT NULL,
    channel_session_ref text NOT NULL,
    channel_epoch  integer NOT NULL,
    execution_id  uuid,
    ledger_sequence bigint,
    route_class   text,
    cause         text,
    payload_ref   text,
    payload_preview text,
    actor_id      uuid NOT NULL,
    event_seq     bigint GENERATED ALWAYS AS IDENTITY,
    body_digest   text NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT rt_events_kind_vocabulary CHECK (kind IN ('session-started','session-reattached','session-completed','session-failed','turn-recorded','interruption-recorded','transfer-recorded','failure-recorded')),
    CONSTRAINT rt_events_direction_vocabulary CHECK (direction IN ('inbound','outbound','internal')),
    CONSTRAINT rt_events_route_class CHECK (route_class IS NULL OR route_class IN ('deterministic','hybrid','generative')),
    CONSTRAINT rt_events_epoch_positive CHECK (channel_epoch >= 1),
    CONSTRAINT rt_events_cause_bounded CHECK (cause IS NULL OR length(cause) <= 2000),
    CONSTRAINT rt_events_payload_ref_bounded CHECK (payload_ref IS NULL OR length(payload_ref) <= 512),
    CONSTRAINT rt_events_preview_bounded CHECK (payload_preview IS NULL OR length(payload_preview) <= 512),
    CONSTRAINT rt_events_digest_nonempty CHECK (length(body_digest) BETWEEN 1 AND 128),
    CONSTRAINT rt_events_key_nonempty CHECK (length(event_key) BETWEEN 1 AND 200),
    CONSTRAINT rt_events_key_unique UNIQUE (application_id, session_id, event_key),
    CONSTRAINT rt_events_sequence_positive CHECK (ledger_sequence IS NULL OR ledger_sequence >= 1),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT rt_events_session_fk FOREIGN KEY (session_id)
        REFERENCES deployments.realtime_sessions (id)
);

CREATE INDEX rt_events_session_order
    ON deployments.realtime_events (application_id, session_id, event_seq);

CREATE INDEX rt_events_ledger_link
    ON deployments.realtime_events (application_id, execution_id, ledger_sequence);

-- An inbound row must arrive on the session's CURRENT channel coordinates —
-- a stale callback (superseded ref/epoch) cannot mutate this session.
CREATE OR REPLACE FUNCTION deployments.rt_events_channel_fresh() RETURNS trigger AS $$ DECLARE session_channel_ref text; session_epoch integer; session_status text; BEGIN SELECT channel_session_ref, channel_epoch, status INTO session_channel_ref, session_epoch, session_status FROM deployments.realtime_sessions WHERE id = NEW.session_id AND application_id = NEW.application_id; IF session_channel_ref IS NULL THEN RAISE EXCEPTION 'realtime event references unknown session %', NEW.session_id; END IF; IF NEW.direction = 'inbound' AND (NEW.channel_session_ref <> session_channel_ref OR NEW.channel_epoch <> session_epoch) THEN RAISE EXCEPTION 'stale realtime callback rejected: event on channel % epoch % but session % currently holds channel % epoch %', NEW.channel_session_ref, NEW.channel_epoch, NEW.session_id, session_channel_ref, session_epoch; END IF; IF session_status IN ('closed','failed','transferred') AND NEW.direction = 'inbound' THEN RAISE EXCEPTION 'realtime session % is terminal (%); inbound events are rejected', NEW.session_id, session_status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_events_channel_fresh_guard
    BEFORE INSERT ON deployments.realtime_events
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_events_channel_fresh();

CREATE OR REPLACE FUNCTION deployments.rt_events_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.realtime_events is append-only (event %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_events_append_only_guard
    BEFORE UPDATE OR DELETE ON deployments.realtime_events
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_events_append_only();

-- ---------------------------------------------------------------------------
-- The durable, recoverable realtime OPERATION state (the architect's
-- crash-safety correction for PR #46). One row per governed rail-side
-- effect: PENDING (claimed, not durably complete — a crash in the
-- claim/completion window leaves this; a retry MUST resume with the
-- STABLE rail-level idempotency key) -> COMPLETED (the durable outcome
-- exists; replays return it with no side effect) | FAILED (a durably
-- recorded terminal failure outcome — the rail refused).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.realtime_operations (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    -- Provenance reference WITHOUT FK by design: a session-start
    -- operation row is durably claimed BEFORE the session row exists
    -- (that ordering is exactly the crash window this ledger closes).
    session_id     uuid,
    deployment_id  uuid NOT NULL,
    execution_id   uuid,
    operation_kind text NOT NULL,
    operation_key  text NOT NULL,
    status         text NOT NULL,
    attempts       integer NOT NULL DEFAULT 1,
    -- Bounded stage checkpoint (the past-the-point-of-no-return facts a
    -- crash-resume completes from; never media, never secrets).
    checkpoint     jsonb,
    failure_reason text,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    completed_at   timestamptz,
    CONSTRAINT rt_ops_kind_vocabulary CHECK (operation_kind IN ('session-start','turn-delivery','human-transfer','session-close')),
    CONSTRAINT rt_ops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT rt_ops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT rt_ops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT rt_ops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT rt_ops_checkpoint_bounded CHECK (checkpoint IS NULL OR pg_column_size(checkpoint) <= 4096),
    CONSTRAINT rt_ops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT rt_ops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT rt_ops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT rt_ops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT rt_ops_key_unique UNIQUE (application_id, operation_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX rt_ops_session_listing
    ON deployments.realtime_operations (application_id, session_id, created_at);

CREATE INDEX rt_ops_pending_scan
    ON deployments.realtime_operations (application_id, status, updated_at)
    WHERE status = 'pending';

-- The identity core is write-once: application/tenant/deployment
-- binding, the operation kind and key, the session/execution
-- provenance references and the creation timestamp never move.
CREATE OR REPLACE FUNCTION deployments.rt_ops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.realtime_operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_ops_core_guard
    BEFORE UPDATE ON deployments.realtime_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_ops_core_immutable();

-- The recoverable status machine: only PENDING may move (to COMPLETED
-- or FAILED, with the outcome fields set atomically); COMPLETED/FAILED
-- are terminal-immutable (checkpoint/failure/reason/timestamps frozen);
-- attempts never regress. A physical UPDATE of a terminal row is
-- unrepresentable.
CREATE OR REPLACE FUNCTION deployments.rt_ops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'deployments.realtime_operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) THEN RAISE EXCEPTION 'realtime operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_ops_lifecycle_guard
    BEFORE UPDATE ON deployments.realtime_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_ops_lifecycle();

CREATE OR REPLACE FUNCTION deployments.rt_ops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.realtime_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER rt_ops_no_delete_guard
    BEFORE DELETE ON deployments.realtime_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.rt_ops_no_delete();
