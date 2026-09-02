-- WORK-027 — Computer-use and GUI execution (CUI-001/002/003).
--
-- The durable state of the governed computer-use fabric: SESSIONS (the
-- closed subordinate lifecycle: denied | active | terminal, with the
-- frozen deterministic -> browser -> desktop escalation ladder pinned
-- physically), the append-only ESCALATION ledger (gapless per-session
-- sequence, insufficiency-digest protected), the keyed ACTION journal
-- (request-fingerprint arbitration, dispatching -> terminal exactly once),
-- the append-only sequence-gapless OBSERVATION ledger (retention/redaction
-- metadata, canonical body digests) and the DURABLE, RECOVERABLE
-- OPERATION STATE (the WORK-024 crash-safety standard: PENDING ->
-- COMPLETED|FAILED, stable keys, monotonic attempts, stage checkpoints,
-- terminal immutability).
--
-- AUTHORITY PRESERVATION (the frozen invariants + this Work Order):
--   * every table references the EXISTING execution identity through the
--     composite key (execution_id, application_id) -> executions.executions
--     and (application_id, tenant_id) -> applications.applications — there
--     is NO second execution identity and NO second lifecycle anywhere in
--     this migration; a computer-use session is subordinate bookkeeping;
--   * execution status is NEVER written here: computer-use provenance
--     rides the CANONICAL EventEnvelope ledger through the tools module's
--     recordStepEvent seam (reusing the tools producer vocabulary
--     tool-requested / tool-result / tool-denied — the WORK-010
--     discipline); these tables store durable state, never a second event
--     stream;
--   * the computer-use escalation ladder is a PLANNING PREFERENCE pinned
--     physically (current_mode may only ASCEND the frozen order
--     deterministic -> browser -> desktop); the decisive authorities
--     (policy, capability, budget, secret) are consulted through their
--     seams BEFORE any environment interaction — nothing here re-decides.
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * computer_use_sessions: one row per (application, session_key) with
--     request-fingerprint arbitration; insert admits ONLY active (on a
--     NON-TERMINAL execution) or denied (pure evidence, always
--     journalable); the identity core (tenant/execution/session key/
--     fingerprint/task kind/initial mode/route evidence/admission bundle/
--     creation time) is write-once; status moves active ->
--     completed|failed|cancelled exactly once (terminal rows fully
--     immutable); denial fields exist ONLY on denied rows; environment
--     reference + opened-mode are set/cleared together; rows are never
--     deleted;
--   * computer_use_escalations: APPEND-ONLY (no UPDATE/DELETE), gapless
--     per-session escalation_sequence (count-gated, convergence-aware: an
--     exact duplicate — same sequence, same target mode — passes to the
--     (application, session, to_mode) UNIQUE arbiter; a different mode on
--     the same sequence fails closed), the insufficiency digest is 64 hex
--     (fabricated escalation evidence is unrepresentable), the session
--     must be ACTIVE at insert;
--   * computer_use_actions: the keyed journal — one row per (application,
--     session, action_key) with input-digest arbitration; gapless
--     per-session action_sequence INCLUDING denied requests (convergence
--     aware on the action key); dispatching -> succeeded|failed|denied
--     exactly once; terminal rows fully immutable; the ledger sequence
--     bindings are write-once (NULL -> value, never moved); the mode/
--     action-type vocabularies and the typed side-effect classification
--     are CHECK-bound; rows are never deleted;
--   * computer_use_observations: APPEND-ONLY (no UPDATE/DELETE), gapless
--     per-session sequence with the convergence-aware digest discipline
--     (same sequence + same content digest passes to the UNIQUE arbiter;
--     same sequence + different digest fails closed — IDEMPOTENCY_KEY_
--     REUSED), retention/redaction vocabularies CHECK-bound, ephemeral
--     observations carry NO content, the session must be ACTIVE;
--   * computer_use_operations: the realtime_operations/messaging_
--     operations/execution_operations discipline — PENDING -> COMPLETED|
--     FAILED only, terminal rows fully immutable, attempts monotonic, the
--     stage checkpoint writable only while PENDING, stable-key UNIQUE
--     claim (application_id, operation_key), rows never deleted.
--
-- Migration-version discipline (the collision rule, parallel wave-5):
-- the live inventory at authoring time is 0001..0014, 0016..0022 (0015 is
-- BURNED — WORK-019's owned number, absent from the tree; 0016 = WORK-022,
-- 0017 = WORK-020, 0018 = WORK-024, 0019 = WORK-021, 0020 = WORK-025,
-- 0021 = WORK-026, 0022 = WORK-028 — all merged before this wave).
-- **WORK-027 claims 0023 — THIS migration. No other unmerged Work Order
-- claims 0023.** (Convention pinned in docs/work-items/WORK-018.md §
-- migration discipline.)
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

-- ---------------------------------------------------------------------------
-- Computer-use sessions (the closed subordinate lifecycle)
-- ---------------------------------------------------------------------------

CREATE TABLE tools.computer_use_sessions (
    id                      uuid PRIMARY KEY,
    application_id          uuid NOT NULL,
    tenant_id               uuid NOT NULL,
    execution_id            uuid NOT NULL,
    session_key             text NOT NULL,
    request_fingerprint     text NOT NULL,
    task_kind               text NOT NULL,
    status                  text NOT NULL,
    initial_mode            text NOT NULL,
    current_mode            text NOT NULL,
    route_evidence          jsonb NOT NULL,
    admission               jsonb NOT NULL,
    mode_context            jsonb NOT NULL,
    environment_ref         text,
    environment_opened_mode text,
    denial_class            text,
    denial_reason           text,
    escalation_count        integer NOT NULL DEFAULT 0,
    usage_micro_usd         text NOT NULL DEFAULT '0',
    requested_at            timestamptz NOT NULL,
    activated_at            timestamptz,
    terminal_at             timestamptz,
    terminal_cause          text,
    created_at              timestamptz NOT NULL,
    updated_at              timestamptz NOT NULL,
    CONSTRAINT cu_session_key_bounded CHECK (length(session_key) BETWEEN 1 AND 200),
    CONSTRAINT cu_session_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT cu_session_task_kind_vocabulary CHECK (task_kind IN ('structured-data-retrieval','web-workflow','desktop-workflow','terminal-task')),
    CONSTRAINT cu_session_status_vocabulary CHECK (status IN ('denied','active','completed','failed','cancelled')),
    CONSTRAINT cu_session_mode_vocabulary CHECK (initial_mode IN ('deterministic','browser','desktop') AND current_mode IN ('deterministic','browser','desktop')),
    CONSTRAINT cu_session_denial_vocabulary CHECK (denial_class IS NULL OR denial_class IN ('policy','budget','capability','secret-mediation')),
    CONSTRAINT cu_session_denial_reason_bounded CHECK (denial_reason IS NULL OR length(denial_reason) <= 500),
    CONSTRAINT cu_session_denial_shape CHECK (
        (status = 'denied' AND denial_class IS NOT NULL AND denial_reason IS NOT NULL)
        OR (status <> 'denied' AND denial_class IS NULL AND denial_reason IS NULL)
    ),
    CONSTRAINT cu_session_activation_shape CHECK (
        (status = 'denied' AND activated_at IS NULL)
        OR (status <> 'denied' AND activated_at IS NOT NULL)
    ),
    CONSTRAINT cu_session_terminal_shape CHECK (
        (status IN ('completed','failed','cancelled') AND terminal_at IS NOT NULL AND terminal_cause = status)
        OR (status IN ('denied','active') AND terminal_at IS NULL AND terminal_cause IS NULL)
    ),
    CONSTRAINT cu_session_environment_shape CHECK (
        (environment_ref IS NULL AND environment_opened_mode IS NULL)
        OR (environment_ref IS NOT NULL AND environment_opened_mode IS NOT NULL)
    ),
    CONSTRAINT cu_session_opened_mode_vocabulary CHECK (environment_opened_mode IS NULL OR environment_opened_mode IN ('deterministic','browser','desktop')),
    CONSTRAINT cu_session_escalations_nonnegative CHECK (escalation_count >= 0),
    CONSTRAINT cu_session_usage_shape CHECK (usage_micro_usd ~ '^[0-9]{1,19}$'),
    CONSTRAINT cu_session_key_unique UNIQUE (application_id, session_key),
    CONSTRAINT cu_session_identity_unique UNIQUE (id, application_id),
    CONSTRAINT cu_session_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT cu_session_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX cu_sessions_by_execution
    ON tools.computer_use_sessions (application_id, execution_id, created_at);

-- The insert gate: only ACTIVE (bound to a NON-TERMINAL execution) or
-- DENIED (pure admission evidence — always journalable, even when the
-- execution went terminal during the admission window) rows may appear.
CREATE OR REPLACE FUNCTION tools.cu_sessions_insert_gate() RETURNS trigger AS $$ DECLARE terminal boolean; BEGIN IF NEW.status NOT IN ('active','denied') THEN RAISE EXCEPTION 'computer-use sessions are inserted active or denied only (got %)', NEW.status; END IF; SELECT status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED') INTO terminal FROM executions.executions WHERE id = NEW.execution_id AND application_id = NEW.application_id; IF terminal IS NULL THEN RAISE EXCEPTION 'execution % does not exist in application %', NEW.execution_id, NEW.application_id; END IF; IF terminal AND NEW.status <> 'denied' THEN RAISE EXCEPTION 'execution % is terminal; no active computer-use session may be created on it', NEW.execution_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_sessions_insert_gate
    BEFORE INSERT ON tools.computer_use_sessions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_sessions_insert_gate();

-- The identity core is write-once: the tenant/execution binding, the
-- session key, the request fingerprint, the task kind, the initial mode,
-- the recorded route evidence + admission bundle and the creation
-- timestamp never move. Denial fields never appear on a non-denied row
-- and never change once set.
CREATE OR REPLACE FUNCTION tools.cu_sessions_core_guard() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.session_key <> OLD.session_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.task_kind <> OLD.task_kind OR NEW.initial_mode <> OLD.initial_mode OR NEW.created_at <> OLD.created_at OR (NEW.route_evidence)::text <> (OLD.route_evidence)::text OR (NEW.admission)::text <> (OLD.admission)::text THEN RAISE EXCEPTION 'tools.computer_use_sessions identity core is immutable (session %)', OLD.id; END IF; IF OLD.status = 'denied' AND NEW.status <> 'denied' THEN RAISE EXCEPTION 'a denied computer-use session is terminal-immutable (session %)', OLD.id; END IF; IF (OLD.denial_class IS NOT NULL AND NEW.denial_class <> OLD.denial_class) OR (OLD.denial_class IS NULL AND NEW.denial_class IS NOT NULL) THEN RAISE EXCEPTION 'computer-use session % denial evidence is write-once', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_sessions_core_guard
    BEFORE UPDATE ON tools.computer_use_sessions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_sessions_core_guard();

-- The guarded lifecycle: active -> completed|failed|cancelled exactly
-- once; terminal rows fully immutable (only the no-op identity update
-- survives); the escalation ladder only ASCENDS (the frozen
-- deterministic -> browser -> desktop order is physical, not advisory).
CREATE OR REPLACE FUNCTION tools.cu_sessions_lifecycle_guard() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed','cancelled') AND (NEW.status <> OLD.status OR NEW.terminal_at <> OLD.terminal_at OR NEW.terminal_cause <> OLD.terminal_cause OR NEW.updated_at <> OLD.updated_at) THEN RAISE EXCEPTION 'computer-use session % is terminal-immutable in status %', OLD.id, OLD.status; END IF; IF OLD.status = 'active' AND NEW.status NOT IN ('active','completed','failed','cancelled') THEN RAISE EXCEPTION 'computer-use session % cannot move from active to %', OLD.id, NEW.status; END IF; IF OLD.status = 'active' AND NEW.status <> 'active' AND (NEW.terminal_at IS NULL OR NEW.terminal_cause <> NEW.status) THEN RAISE EXCEPTION 'terminal computer-use session % requires terminal_at and its own cause', OLD.id; END IF; IF OLD.status = 'active' AND NEW.status = 'active' AND NEW.terminal_at IS NOT NULL THEN RAISE EXCEPTION 'an active computer-use session cannot carry terminal evidence (session %)', OLD.id; END IF; IF array_position(ARRAY['deterministic','browser','desktop'], NEW.current_mode) < array_position(ARRAY['deterministic','browser','desktop'], OLD.current_mode) THEN RAISE EXCEPTION 'computer-use session % escalation ladder only ascends (% -> %)', OLD.id, OLD.current_mode, NEW.current_mode; END IF; IF array_position(ARRAY['deterministic','browser','desktop'], NEW.current_mode) < array_position(ARRAY['deterministic','browser','desktop'], NEW.initial_mode) THEN RAISE EXCEPTION 'computer-use session % current mode cannot precede its initial mode', OLD.id; END IF; IF NEW.escalation_count < OLD.escalation_count THEN RAISE EXCEPTION 'computer-use session % escalation count never regresses', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_sessions_lifecycle_guard
    BEFORE UPDATE ON tools.computer_use_sessions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_sessions_lifecycle_guard();

CREATE OR REPLACE FUNCTION tools.cu_sessions_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.computer_use_sessions rows are never deleted (session %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_sessions_no_delete_guard
    BEFORE DELETE ON tools.computer_use_sessions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_sessions_no_delete();

-- ---------------------------------------------------------------------------
-- Computer-use escalations (append-only, gapless, digest-protected)
-- ---------------------------------------------------------------------------

CREATE TABLE tools.computer_use_escalations (
    id                   uuid PRIMARY KEY,
    application_id       uuid NOT NULL,
    tenant_id            uuid NOT NULL,
    session_id           uuid NOT NULL,
    execution_id         uuid NOT NULL,
    escalation_sequence  integer NOT NULL,
    from_mode            text NOT NULL,
    to_mode              text NOT NULL,
    reason_code          text NOT NULL,
    reason_detail        text NOT NULL,
    insufficiency_digest text NOT NULL,
    capability_id        text NOT NULL,
    admitted_at          timestamptz NOT NULL,
    ledger_sequence      integer,
    CONSTRAINT cu_escalation_sequence_positive CHECK (escalation_sequence >= 1),
    CONSTRAINT cu_escalation_mode_vocabulary CHECK (from_mode IN ('deterministic','browser','desktop') AND to_mode IN ('deterministic','browser','desktop')),
    CONSTRAINT cu_escalation_ascends CHECK (array_position(ARRAY['deterministic','browser','desktop'], to_mode) = array_position(ARRAY['deterministic','browser','desktop'], from_mode) + 1),
    CONSTRAINT cu_escalation_reason_code_bounded CHECK (length(reason_code) BETWEEN 1 AND 200),
    CONSTRAINT cu_escalation_reason_detail_bounded CHECK (length(reason_detail) BETWEEN 1 AND 500),
    CONSTRAINT cu_escalation_digest_shape CHECK (insufficiency_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cu_escalation_capability_bounded CHECK (length(capability_id) BETWEEN 1 AND 120),
    CONSTRAINT cu_escalation_mode_unique UNIQUE (application_id, session_id, to_mode),
    CONSTRAINT cu_escalation_session_fk
        FOREIGN KEY (session_id, application_id)
        REFERENCES tools.computer_use_sessions (id, application_id),
    CONSTRAINT cu_escalation_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX cu_escalations_by_session
    ON tools.computer_use_escalations (application_id, session_id, escalation_sequence);

CREATE OR REPLACE FUNCTION tools.cu_escalations_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.computer_use_escalations is append-only (rejected % on escalation %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_escalations_no_mutation
    BEFORE UPDATE OR DELETE ON tools.computer_use_escalations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_escalations_append_only();

-- An escalation is exactly the NEXT escalation of its session (count
-- gate, gapless) and requires an ACTIVE session. CONVERGENCE-AWARE: the
-- store inserts with ON CONFLICT (application_id, session_id, to_mode)
-- DO NOTHING and a BEFORE-INSERT trigger runs BEFORE the conflict
-- arbiter — so an exact duplicate (same sequence, same target mode — the
-- crash-resume re-issue of an already-committed escalation) passes this
-- gate and lets the UNIQUE deduplicate it. A same-sequence/different-mode
-- insert is physical sequence reuse and fails closed right here.
CREATE OR REPLACE FUNCTION tools.cu_escalations_sequence_gate() RETURNS trigger AS $$ DECLARE existing integer; existing_mode text; session_status text; BEGIN SELECT to_mode INTO existing_mode FROM tools.computer_use_escalations WHERE session_id = NEW.session_id AND application_id = NEW.application_id AND escalation_sequence = NEW.escalation_sequence; IF existing_mode IS NOT NULL THEN IF existing_mode = NEW.to_mode THEN RETURN NEW; END IF; RAISE EXCEPTION 'computer-use session % escalation sequence % already exists with a different target mode (same sequence, different escalation)', NEW.session_id, NEW.escalation_sequence; END IF; SELECT COUNT(*) INTO existing FROM tools.computer_use_escalations WHERE session_id = NEW.session_id AND application_id = NEW.application_id; IF NEW.escalation_sequence IS DISTINCT FROM existing + 1 THEN RAISE EXCEPTION 'computer-use session % escalation sequence must be gapless (expected %, got %)', NEW.session_id, existing + 1, NEW.escalation_sequence; END IF; SELECT status INTO session_status FROM tools.computer_use_sessions WHERE id = NEW.session_id AND application_id = NEW.application_id; IF session_status IS NULL THEN RAISE EXCEPTION 'computer-use session % does not exist in application %', NEW.session_id, NEW.application_id; END IF; IF session_status <> 'active' THEN RAISE EXCEPTION 'computer-use session % is %; escalations require an active session', NEW.session_id, session_status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_escalations_sequence_gate
    BEFORE INSERT ON tools.computer_use_escalations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_escalations_sequence_gate();

-- ---------------------------------------------------------------------------
-- Computer-use actions (the keyed journal)
-- ---------------------------------------------------------------------------

CREATE TABLE tools.computer_use_actions (
    id                       uuid PRIMARY KEY,
    application_id           uuid NOT NULL,
    tenant_id                uuid NOT NULL,
    session_id               uuid NOT NULL,
    execution_id             uuid NOT NULL,
    action_key               text NOT NULL,
    action_sequence          integer NOT NULL,
    mode                     text NOT NULL,
    action_type              text NOT NULL,
    target                   text NOT NULL,
    side_effect              text NOT NULL,
    status                   text NOT NULL,
    capability_id            text NOT NULL,
    failure_class            text,
    failure_message          text,
    input_digest             text NOT NULL,
    result_digest            text,
    usage_micro_usd          text,
    environment_ref          text,
    sandbox_execution_id     text,
    observation_sequences    jsonb NOT NULL DEFAULT '[]'::jsonb,
    requested_at             timestamptz NOT NULL,
    dispatched_at            timestamptz,
    completed_at             timestamptz,
    duration_ms              integer,
    ledger_requested_sequence integer,
    ledger_result_sequence   integer,
    CONSTRAINT cu_action_sequence_positive CHECK (action_sequence >= 1),
    CONSTRAINT cu_action_key_bounded CHECK (length(action_key) BETWEEN 1 AND 200),
    CONSTRAINT cu_action_mode_vocabulary CHECK (mode IN ('deterministic','browser','desktop')),
    CONSTRAINT cu_action_type_vocabulary CHECK (action_type IN ('api-call','navigate','click','type','scroll','read-dom','read-accessibility-tree','screenshot','terminal-exec','input-event','window-action','clipboard-read','clipboard-write','file-read','file-write','download')),
    CONSTRAINT cu_action_target_bounded CHECK (length(target) BETWEEN 1 AND 2000),
    CONSTRAINT cu_action_side_effect_vocabulary CHECK (side_effect IN ('none','read-only','write-external')),
    CONSTRAINT cu_action_status_vocabulary CHECK (status IN ('dispatching','succeeded','failed','denied')),
    CONSTRAINT cu_action_capability_bounded CHECK (length(capability_id) BETWEEN 1 AND 120),
    CONSTRAINT cu_action_failure_class_bounded CHECK (failure_class IS NULL OR length(failure_class) <= 200),
    CONSTRAINT cu_action_failure_message_bounded CHECK (failure_message IS NULL OR length(failure_message) <= 512),
    CONSTRAINT cu_action_input_digest_shape CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cu_action_result_digest_shape CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cu_action_usage_shape CHECK (usage_micro_usd IS NULL OR usage_micro_usd ~ '^[0-9]{1,19}$'),
    CONSTRAINT cu_action_sandbox_ref_bounded CHECK (sandbox_execution_id IS NULL OR length(sandbox_execution_id) <= 200),
    CONSTRAINT cu_action_environment_ref_bounded CHECK (environment_ref IS NULL OR length(environment_ref) <= 200),
    CONSTRAINT cu_action_observation_shape CHECK (jsonb_typeof(observation_sequences) = 'array'),
    CONSTRAINT cu_action_dispatching_shape CHECK (status <> 'dispatching' OR (result_digest IS NULL AND usage_micro_usd IS NULL AND completed_at IS NULL AND failure_class IS NULL AND duration_ms IS NULL)),
    CONSTRAINT cu_action_denied_shape CHECK (status <> 'denied' OR (failure_class IS NOT NULL AND completed_at IS NOT NULL AND result_digest IS NULL AND usage_micro_usd IS NULL)),
    CONSTRAINT cu_action_denied_no_dispatch CHECK (status <> 'denied' OR dispatched_at IS NULL),
    CONSTRAINT cu_action_outcome_shape CHECK (status NOT IN ('succeeded','failed') OR completed_at IS NOT NULL),
    CONSTRAINT cu_action_key_unique UNIQUE (application_id, session_id, action_key),
    CONSTRAINT cu_action_identity_unique UNIQUE (id, application_id),
    CONSTRAINT cu_action_session_fk
        FOREIGN KEY (session_id, application_id)
        REFERENCES tools.computer_use_sessions (id, application_id),
    CONSTRAINT cu_action_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX cu_actions_by_session
    ON tools.computer_use_actions (application_id, session_id, action_sequence);

CREATE INDEX cu_actions_by_execution
    ON tools.computer_use_actions (application_id, execution_id, requested_at);

CREATE OR REPLACE FUNCTION tools.cu_actions_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.computer_use_actions rows are never deleted (action %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_actions_no_delete_guard
    BEFORE DELETE ON tools.computer_use_actions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_actions_no_delete();

-- An action is exactly the NEXT action request of its session (count
-- gate, gapless — denied requests included: they are ordered trajectory
-- evidence) on an ACTIVE session. CONVERGENCE-AWARE on the action key: a
-- re-insert of an already-committed (application, session, action_key)
-- row passes this gate and lets the UNIQUE deduplicate it; a
-- same-sequence/different-key insert is physical sequence reuse and
-- fails closed.
CREATE OR REPLACE FUNCTION tools.cu_actions_sequence_gate() RETURNS trigger AS $$ DECLARE existing integer; existing_key text; session_status text; BEGIN SELECT action_key INTO existing_key FROM tools.computer_use_actions WHERE session_id = NEW.session_id AND application_id = NEW.application_id AND action_key = NEW.action_key; IF existing_key IS NOT NULL THEN RETURN NEW; END IF; SELECT COUNT(*) INTO existing FROM tools.computer_use_actions WHERE session_id = NEW.session_id AND application_id = NEW.application_id; IF NEW.action_sequence IS DISTINCT FROM existing + 1 THEN RAISE EXCEPTION 'computer-use session % action sequence must be gapless (expected %, got %)', NEW.session_id, existing + 1, NEW.action_sequence; END IF; SELECT status INTO session_status FROM tools.computer_use_sessions WHERE id = NEW.session_id AND application_id = NEW.application_id; IF session_status IS NULL THEN RAISE EXCEPTION 'computer-use session % does not exist in application %', NEW.session_id, NEW.application_id; END IF; IF session_status <> 'active' THEN RAISE EXCEPTION 'computer-use session % is %; actions require an active session', NEW.session_id, session_status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_actions_sequence_gate
    BEFORE INSERT ON tools.computer_use_actions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_actions_sequence_gate();

-- The action core is write-once: identity, request, classification and
-- the requested ledger binding never move; the result ledger binding is
-- write-once (NULL -> value); dispatching -> succeeded|failed|denied
-- exactly once; terminal rows are fully immutable.
CREATE OR REPLACE FUNCTION tools.cu_actions_lifecycle_guard() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.session_id <> OLD.session_id OR NEW.execution_id <> OLD.execution_id OR NEW.action_key <> OLD.action_key OR NEW.action_sequence <> OLD.action_sequence OR NEW.mode <> OLD.mode OR NEW.action_type <> OLD.action_type OR NEW.target <> OLD.target OR NEW.side_effect <> OLD.side_effect OR NEW.capability_id <> OLD.capability_id OR NEW.input_digest <> OLD.input_digest OR NEW.requested_at <> OLD.requested_at OR (NEW.ledger_requested_sequence IS NOT NULL AND OLD.ledger_requested_sequence IS NOT NULL AND NEW.ledger_requested_sequence <> OLD.ledger_requested_sequence) OR (NEW.ledger_result_sequence IS NOT NULL AND OLD.ledger_result_sequence IS NOT NULL AND NEW.ledger_result_sequence <> OLD.ledger_result_sequence) THEN RAISE EXCEPTION 'tools.computer_use_actions identity core is immutable (action %)', OLD.id; END IF; IF OLD.status IN ('succeeded','failed','denied') AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'tools.computer_use_actions is terminal-immutable in status % (action %)', OLD.status, OLD.id; END IF; IF OLD.status = 'dispatching' AND NEW.status NOT IN ('dispatching','succeeded','failed','denied') THEN RAISE EXCEPTION 'computer-use action % cannot move from dispatching to %', OLD.id, NEW.status; END IF; IF OLD.status = 'dispatching' AND NEW.status = 'dispatching' AND (NEW.completed_at IS NOT NULL OR NEW.result_digest IS NOT NULL OR NEW.failure_class IS NOT NULL) THEN RAISE EXCEPTION 'a dispatching computer-use action carries no outcome (action %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_actions_lifecycle_guard
    BEFORE UPDATE ON tools.computer_use_actions
    FOR EACH ROW EXECUTE FUNCTION tools.cu_actions_lifecycle_guard();

-- ---------------------------------------------------------------------------
-- Computer-use observations (append-only, gapless, digest-protected,
-- retention/redaction metadata)
-- ---------------------------------------------------------------------------

CREATE TABLE tools.computer_use_observations (
    id               uuid PRIMARY KEY,
    application_id   uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    session_id       uuid NOT NULL,
    execution_id     uuid NOT NULL,
    observation_sequence integer NOT NULL,
    observation_type text NOT NULL,
    mode             text NOT NULL,
    content_digest   text NOT NULL,
    retention        text NOT NULL,
    redaction        text NOT NULL,
    content          text,
    artifact_ref     text,
    capability_id    text NOT NULL,
    action_id        uuid,
    observed_at      timestamptz NOT NULL,
    ledger_sequence  integer,
    CONSTRAINT cu_observation_sequence_positive CHECK (observation_sequence >= 1),
    CONSTRAINT cu_observation_type_vocabulary CHECK (observation_type IN ('dom','accessibility-tree','screenshot','terminal-output','api-result')),
    CONSTRAINT cu_observation_mode_vocabulary CHECK (mode IN ('deterministic','browser','desktop')),
    CONSTRAINT cu_observation_digest_shape CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT cu_observation_retention_vocabulary CHECK (retention IN ('session','execution','ephemeral')),
    CONSTRAINT cu_observation_redaction_vocabulary CHECK (redaction IN ('none','sensitive-ui','secret-bearing')),
    CONSTRAINT cu_observation_ephemeral_has_no_content CHECK (retention <> 'ephemeral' OR content IS NULL),
    CONSTRAINT cu_observation_capability_bounded CHECK (length(capability_id) BETWEEN 1 AND 120),
    CONSTRAINT cu_observation_content_bounded CHECK (content IS NULL OR length(content) <= 16384),
    CONSTRAINT cu_observation_artifact_bounded CHECK (artifact_ref IS NULL OR length(artifact_ref) <= 500),
    CONSTRAINT cu_observation_sequence_unique UNIQUE (application_id, session_id, observation_sequence),
    CONSTRAINT cu_observation_session_fk
        FOREIGN KEY (session_id, application_id)
        REFERENCES tools.computer_use_sessions (id, application_id),
    CONSTRAINT cu_observation_action_fk
        FOREIGN KEY (action_id, application_id)
        REFERENCES tools.computer_use_actions (id, application_id)
);

CREATE INDEX cu_observations_by_session
    ON tools.computer_use_observations (application_id, session_id, observation_sequence);

CREATE INDEX cu_observations_by_execution
    ON tools.computer_use_observations (application_id, execution_id, observed_at);

CREATE OR REPLACE FUNCTION tools.cu_observations_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.computer_use_observations is append-only (rejected % on observation %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_observations_no_mutation
    BEFORE UPDATE OR DELETE ON tools.computer_use_observations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_observations_append_only();

-- An observation is exactly the NEXT observation of its session (count
-- gate, gapless) on an ACTIVE session. CONVERGENCE-AWARE (the WORK-026
-- jsonb lesson: the body digest is computed over the CANONICAL key-sorted
-- form, so a crash-resume replay of the same body digests identically):
-- an exact duplicate — same sequence, same content digest — passes this
-- gate and lets the UNIQUE deduplicate it (one row survives; the store's
-- convergence read returns it); a same-sequence/different-digest insert
-- is PHYSICAL key reuse and fails closed right here.
CREATE OR REPLACE FUNCTION tools.cu_observations_sequence_gate() RETURNS trigger AS $$ DECLARE existing integer; existing_digest text; session_status text; BEGIN SELECT content_digest INTO existing_digest FROM tools.computer_use_observations WHERE session_id = NEW.session_id AND application_id = NEW.application_id AND observation_sequence = NEW.observation_sequence; IF existing_digest IS NOT NULL THEN IF existing_digest = NEW.content_digest THEN RETURN NEW; END IF; RAISE EXCEPTION 'computer-use session % observation sequence % already exists with a different content digest (same key, different body)', NEW.session_id, NEW.observation_sequence; END IF; SELECT COUNT(*) INTO existing FROM tools.computer_use_observations WHERE session_id = NEW.session_id AND application_id = NEW.application_id; IF NEW.observation_sequence IS DISTINCT FROM existing + 1 THEN RAISE EXCEPTION 'computer-use session % observation sequence must be gapless (expected %, got %)', NEW.session_id, existing + 1, NEW.observation_sequence; END IF; SELECT status INTO session_status FROM tools.computer_use_sessions WHERE id = NEW.session_id AND application_id = NEW.application_id; IF session_status IS NULL THEN RAISE EXCEPTION 'computer-use session % does not exist in application %', NEW.session_id, NEW.application_id; END IF; IF session_status <> 'active' THEN RAISE EXCEPTION 'computer-use session % is %; observations require an active session', NEW.session_id, session_status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_observations_sequence_gate
    BEFORE INSERT ON tools.computer_use_observations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_observations_sequence_gate();

-- ---------------------------------------------------------------------------
-- The durable, recoverable computer-use OPERATION state (the WORK-024
-- crash-safety standard). One row per governed computer-use operation:
-- PENDING (claimed, not durably complete — a crash in the claim/
-- completion window leaves this; a retry MUST resume under the SAME
-- stable key) -> COMPLETED (the durable outcome exists; replays return
-- it with no side effect) | FAILED (a durably recorded terminal failure
-- outcome — e.g. a journaled admission denial).
-- ---------------------------------------------------------------------------

CREATE TABLE tools.computer_use_operations (
    id                  uuid PRIMARY KEY,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    session_id          uuid,
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
    CONSTRAINT cu_ops_kind_vocabulary CHECK (operation_kind IN ('session-create','env-open','action-dispatch','escalation','termination','budget-settle','budget-release')),
    CONSTRAINT cu_ops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT cu_ops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT cu_ops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT cu_ops_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT cu_ops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT cu_ops_stage_bounded CHECK (stage IS NULL OR pg_column_size(stage) <= 4096),
    CONSTRAINT cu_ops_session_shape CHECK (session_id IS NULL OR operation_kind <> 'session-create' OR stage IS NULL OR (stage->>'sessionId') IS NULL OR (stage->>'sessionId') = session_id::text),
    CONSTRAINT cu_ops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT cu_ops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT cu_ops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT cu_ops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT cu_ops_key_unique UNIQUE (application_id, operation_key),
    CONSTRAINT cu_ops_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT cu_ops_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id)
);

CREATE INDEX cu_ops_execution_listing
    ON tools.computer_use_operations (application_id, execution_id, created_at);

CREATE INDEX cu_ops_pending_scan
    ON tools.computer_use_operations (application_id, status, updated_at)
    WHERE status = 'pending';

CREATE INDEX cu_ops_session_listing
    ON tools.computer_use_operations (application_id, session_id, created_at)
    WHERE session_id IS NOT NULL;

-- The identity core is write-once: application/tenant/execution binding,
-- the session provenance reference, the operation kind and key, the
-- request fingerprint and the creation timestamp never move.
CREATE OR REPLACE FUNCTION tools.cu_ops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.session_id <> OLD.session_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'tools.computer_use_operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_ops_core_guard
    BEFORE UPDATE ON tools.computer_use_operations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_ops_core_immutable();

-- The recoverable status machine: only PENDING may move (to COMPLETED
-- or FAILED, with the outcome fields set atomically); COMPLETED/FAILED
-- are terminal-immutable; attempts never regress; the stage checkpoint
-- is writable only while PENDING.
CREATE OR REPLACE FUNCTION tools.cu_ops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'tools.computer_use_operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) THEN RAISE EXCEPTION 'computer-use operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_ops_lifecycle_guard
    BEFORE UPDATE ON tools.computer_use_operations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_ops_lifecycle();

CREATE OR REPLACE FUNCTION tools.cu_ops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.computer_use_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER cu_ops_no_delete_guard
    BEFORE DELETE ON tools.computer_use_operations
    FOR EACH ROW EXECUTE FUNCTION tools.cu_ops_no_delete();
