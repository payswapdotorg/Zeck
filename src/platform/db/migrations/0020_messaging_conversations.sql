-- WORK-025 — Messaging Agent Deployment (MOD-008/009).
--
-- The durable state of the conversational messaging fabric:
-- CONVERSATIONS/THREADS/MESSAGES bound to tenant + application +
-- deployment + PINNED deployment plan version + Execution identity
-- (MOD-009), the APPEND-ONLY message ledger whose inbound rows ARE the
-- idempotency ledger for duplicate inbound events (upstream-supplied
-- event ids or deterministic substitutes — the work order's
-- implementation requirement; provider-native message ids are
-- reference-only `channel_message_ref` evidence, never the primary
-- identity), the delivery-callback EVIDENCE ledger + the guarded
-- monotonic delivery projection, the immutable human-escalation
-- records, and the DURABLE, RECOVERABLE OPERATION STATE.
--
-- AUTHORITY PRESERVATION (the frozen invariants + the WORK-025 work
-- order):
--   * a messaging conversation MAPS TO a governed Execution:
--     execution_id is a REFERENCE (uuid, no FK into executions state)
--     — the conversation never writes execution status and never
--     becomes a second execution or event authority; the canonical
--     inbound-message/reply/delivery/escalation provenance rides the
--     executions EventEnvelope ledger through the executions public
--     recordStepEvent seam (executions vocabulary
--     "agent-session-started" / "agent-action-recorded" /
--     "agent-session-completed"); this message ledger records
--     conversation state + idempotency + ordering evidence + the
--     ledger-sequence linkage (ledger_sequence), never a second event
--     authority;
--   * delivery state is EVIDENCE/PROVENANCE, not a second execution
--     state machine: messaging_deliveries is append-only evidence and
--     the message row's delivery_status is a guarded monotonic
--     projection (pending -> sent -> delivered|undelivered; terminal
--     statuses immutable; regressions physically unrepresentable);
--   * deployment version pinning: the conversation's pinned plan
--     identity is IMMUTABLE for the conversation's lifetime (physical
--     trigger) — promote/rollback on the deployment never rewrites a
--     live conversation's pin and never touches prior Execution
--     identity;
--   * provider neutrality (MOD-008): channel_kind is the neutral
--     deployment vocabulary; channel_conversation_ref /
--     channel_message_ref are the rail's OPAQUE references (mapped at
--     the adapter — provider-native ids are never the primary public
--     identity); rail capability ids arrive only as neutral strings;
--     vendor identifiers are structurally absent;
--   * raw payloads and attachments stay OUT of this ledger: message
--     rows carry bounded payload previews and ARTIFACT REFERENCES
--     (payload_ref + attachments jsonb, CHECK-bounded — the work
--     order's "large attachments through artifact/object references"
--     rule);
--   * cross-module references are READ-ONLY bindings:
--     (application_id, tenant_id) -> applications.applications;
--     deployment_id -> deployments.deployments (the fabric binding);
--     execution_id -> executions.executions by UUID WITHOUT FK (the
--     executions module's idempotent identity is authoritative; the
--     reference records provenance linkage only).
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * messaging_conversations: the identity core (ids, deployment
--     binding, pinned plan version, execution id, creation
--     fingerprint, channel kind, channel conversation ref, ordering
--     mode, created_at) is immutable on every UPDATE path; only the
--     guarded status/closure fields may move (active -> closed only);
--     terminal statuses are fully immutable; rows never deleted;
--   * messaging_messages: APPEND-ONLY (no UPDATE/DELETE except the
--     guarded delivery projection on agent-reply rows), identity-
--     ordered (event_seq), and the inbound idempotency ledger —
--     UNIQUE (application_id, conversation_id, event_key) arbitrates
--     duplicate inbound events (a duplicate converges on the committed
--     row; a same-key/different-body insert fails closed); the
--     delivery projection may move ONLY delivery_status/delivered_at/
--     ledger_sequence, ONLY on agent-reply rows, ONLY forward through
--     the frozen vocabulary (trigger);
--   * messaging_deliveries: APPEND-ONLY evidence (no UPDATE/DELETE);
--     UNIQUE (application_id, conversation_id, callback_key)
--     arbitrates duplicate callbacks; the row must reference an
--     agent-reply message of the same conversation whose recorded
--     channel_message_ref matches (trigger — a callback cannot
--     evidence the wrong message);
--   * messaging_escalations: write-once immutable records; UNIQUE
--     (application_id, escalation_key) arbitrates idempotent
--     escalation retries;
--   * messaging_operations (the WORK-024 crash-safety standard): the
--     DURABLE, RECOVERABLE OPERATION STATE — one row per governed
--     rail-side-effect operation with the PENDING ->
--     COMPLETED|FAILED machine. UNIQUE (application_id, operation_key)
--     arbitrates the durable claim; `attempts` is the retry ledger
--     (monotonic); the checkpoint is bounded jsonb and writable only
--     while PENDING; COMPLETED/FAILED are fully immutable and
--     completion-timestamped; rows are never deleted. conversation_id
--     is a PROVENANCE REFERENCE WITHOUT FK — a conversation-start
--     operation row is durably claimed BEFORE its conversation row
--     exists (that ordering is exactly the crash window this ledger
--     closes);
--   * the conversation status machine is the frozen messaging
--     vocabulary: active -> closed; terminal statuses immutable.
--
-- Migration-version discipline (the collision rule, parallel wave):
-- the live inventory at authoring time is 0001..0014, 0016, 0017 and
-- 0018 (0016_opportunity_analysis.sql, WORK-022; 0017_learned_
-- planning_policies.sql, WORK-020; 0018_realtime_sessions.sql,
-- WORK-024). 0015 is BURNED (WORK-019's owned number; its file is
-- absent from the tree by the documented wave-1 reconciliation
-- anomaly — never reused). The wave-3 pre-assigned numbers by
-- dispatch order: sibling WORK-021 claims 0019 (its file is NOT in
-- this branch), and WORK-025 claims 0020 (THIS migration). No other
-- unmerged Work Order claims 0020.

CREATE TABLE deployments.messaging_conversations (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    deployment_id  uuid NOT NULL,
    pinned_plan_id text NOT NULL,
    pinned_plan_version integer NOT NULL,
    execution_id   uuid NOT NULL,
    channel_kind   text NOT NULL,
    channel_conversation_ref text NOT NULL,
    ordering_mode  text NOT NULL,
    participant_ref text,
    status         text NOT NULL,
    creation_fingerprint text NOT NULL,
    created_by     uuid NOT NULL,
    idempotency_key text NOT NULL,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    closed_at      timestamptz,
    CONSTRAINT msg_conversations_channel_vocabulary CHECK (channel_kind IN ('sms','email','web','in-app')),
    CONSTRAINT msg_conversations_status_vocabulary CHECK (status IN ('active','closed')),
    CONSTRAINT msg_conversations_ordering_vocabulary CHECK (ordering_mode IN ('thread-sequenced','unordered')),
    CONSTRAINT msg_conversations_plan_version_positive CHECK (pinned_plan_version >= 1),
    CONSTRAINT msg_conversations_fingerprint_nonempty CHECK (length(creation_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT msg_conversations_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT msg_conversations_ref_bounded CHECK (length(channel_conversation_ref) BETWEEN 1 AND 200),
    CONSTRAINT msg_conversations_participant_bounded CHECK (participant_ref IS NULL OR length(participant_ref) <= 200),
    CONSTRAINT msg_conversations_key_unique UNIQUE (application_id, idempotency_key),
    CONSTRAINT msg_conversations_channel_unique UNIQUE (application_id, channel_conversation_ref),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT msg_conversations_deployment_fk FOREIGN KEY (deployment_id)
        REFERENCES deployments.deployments (id)
);

CREATE INDEX msg_conversations_scope_listing
    ON deployments.messaging_conversations (application_id, deployment_id, created_at, id);

-- The identity core is write-once: tenant/deployment binding, the
-- PINNED plan version (version pinning), the Execution identity
-- binding, the channel kind, the channel conversation reference, the
-- declared ordering semantics and the creation fingerprint never move
-- after creation.
CREATE OR REPLACE FUNCTION deployments.msg_conversations_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.pinned_plan_id <> OLD.pinned_plan_id OR NEW.pinned_plan_version <> OLD.pinned_plan_version OR NEW.execution_id <> OLD.execution_id OR NEW.channel_kind <> OLD.channel_kind OR NEW.channel_conversation_ref <> OLD.channel_conversation_ref OR NEW.ordering_mode <> OLD.ordering_mode OR NEW.creation_fingerprint <> OLD.creation_fingerprint OR NEW.created_by <> OLD.created_by OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.messaging_conversations identity core is immutable (conversation % — the pinned plan version, execution identity and channel binding never move)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_conversations_core_guard
    BEFORE UPDATE ON deployments.messaging_conversations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_conversations_core_immutable();

-- The frozen messaging conversation status machine (active -> closed
-- only; closed is terminal-immutable).
CREATE OR REPLACE FUNCTION deployments.msg_conversations_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status = 'closed' THEN RAISE EXCEPTION 'deployments.messaging_conversations is terminal-immutable in state % (conversation %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'active' AND NEW.status IN ('active','closed'))) THEN RAISE EXCEPTION 'messaging conversation % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_conversations_lifecycle_guard
    BEFORE UPDATE ON deployments.messaging_conversations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_conversations_lifecycle();

CREATE OR REPLACE FUNCTION deployments.msg_conversations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.messaging_conversations rows are never deleted (conversation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_conversations_no_delete_guard
    BEFORE DELETE ON deployments.messaging_conversations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_conversations_no_delete();

-- ---------------------------------------------------------------------------
-- The append-only message ledger (MOD-009 + the inbound idempotency
-- ledger of the work order's implementation requirements). Zeck-side
-- event_key is the PRIMARY public message identity (inbound dedupe key
-- / outbound send key / marker key); channel_message_ref is the rail's
-- OPAQUE reference, evidence only.
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.messaging_messages (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    conversation_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    kind          text NOT NULL,
    direction     text NOT NULL,
    event_key     text NOT NULL,
    thread_ref    text,
    thread_sequence integer,
    ordering_marker text,
    execution_id  uuid,
    ledger_sequence bigint,
    route_class   text,
    reply_to_event_key text,
    channel_message_ref text,
    delivery_status text,
    delivered_at  timestamptz,
    cause         text,
    payload_ref   text,
    payload_preview text,
    attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
    actor_id      uuid NOT NULL,
    event_seq     bigint GENERATED ALWAYS AS IDENTITY,
    body_digest   text NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT msg_messages_kind_vocabulary CHECK (kind IN ('user-message','agent-reply','system-marker')),
    CONSTRAINT msg_messages_direction_vocabulary CHECK (direction IN ('inbound','outbound','internal')),
    CONSTRAINT msg_messages_ordering_marker CHECK (ordering_marker IS NULL OR ordering_marker IN ('in-order','out-of-order','gap','assigned')),
    CONSTRAINT msg_messages_route_class CHECK (route_class IS NULL OR route_class IN ('deterministic','hybrid','generative')),
    CONSTRAINT msg_messages_delivery_status CHECK (delivery_status IS NULL OR delivery_status IN ('pending','sent','delivered','undelivered')),
    CONSTRAINT msg_messages_delivery_projection_shape CHECK (
        (kind = 'agent-reply' AND direction = 'outbound')
        OR (delivery_status IS NULL AND delivered_at IS NULL)),
    CONSTRAINT msg_messages_inbound_shape CHECK (
        (kind = 'user-message' AND direction = 'inbound')
        OR kind <> 'user-message'),
    CONSTRAINT msg_messages_thread_sequence_positive CHECK (thread_sequence IS NULL OR thread_sequence >= 1),
    CONSTRAINT msg_messages_cause_bounded CHECK (cause IS NULL OR length(cause) <= 2000),
    CONSTRAINT msg_messages_payload_ref_bounded CHECK (payload_ref IS NULL OR length(payload_ref) <= 512),
    CONSTRAINT msg_messages_preview_bounded CHECK (payload_preview IS NULL OR length(payload_preview) <= 512),
    CONSTRAINT msg_messages_channel_ref_bounded CHECK (channel_message_ref IS NULL OR length(channel_message_ref) BETWEEN 1 AND 200),
    CONSTRAINT msg_messages_digest_nonempty CHECK (length(body_digest) BETWEEN 1 AND 128),
    CONSTRAINT msg_messages_key_nonempty CHECK (length(event_key) BETWEEN 1 AND 200),
    CONSTRAINT msg_messages_key_unique UNIQUE (application_id, conversation_id, event_key),
    CONSTRAINT msg_messages_sequence_positive CHECK (ledger_sequence IS NULL OR ledger_sequence >= 1),
    CONSTRAINT msg_messages_attachments_bounded CHECK (pg_column_size(attachments) <= 2048 AND jsonb_array_length(attachments) <= 8),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT msg_messages_conversation_fk FOREIGN KEY (conversation_id)
        REFERENCES deployments.messaging_conversations (id)
);

CREATE INDEX msg_messages_conversation_order
    ON deployments.messaging_messages (application_id, conversation_id, event_seq);

CREATE INDEX msg_messages_ledger_link
    ON deployments.messaging_messages (application_id, execution_id, ledger_sequence);

CREATE INDEX msg_messages_thread_order
    ON deployments.messaging_messages (application_id, conversation_id, thread_ref, thread_sequence)
    WHERE direction = 'inbound';

-- The ledger is append-only; the ONLY mutable projection is the
-- delivery evidence on agent-reply rows (delivery_status / delivered_at
-- / ledger_sequence), and it moves only FORWARD through the frozen
-- vocabulary — terminal delivery statuses are immutable, regressions
-- are physically unrepresentable (delivery state is EVIDENCE, never a
-- second execution state machine).
CREATE OR REPLACE FUNCTION deployments.msg_messages_append_only() RETURNS trigger AS $$ BEGIN IF OLD.kind = 'agent-reply' THEN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.kind <> OLD.kind OR NEW.direction <> OLD.direction OR NEW.event_key <> OLD.event_key OR NEW.thread_ref IS DISTINCT FROM OLD.thread_ref OR NEW.thread_sequence IS DISTINCT FROM OLD.thread_sequence OR NEW.ordering_marker IS DISTINCT FROM OLD.ordering_marker OR NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.route_class IS DISTINCT FROM OLD.route_class OR NEW.reply_to_event_key IS DISTINCT FROM OLD.reply_to_event_key OR NEW.channel_message_ref IS DISTINCT FROM OLD.channel_message_ref OR NEW.cause IS DISTINCT FROM OLD.cause OR NEW.payload_ref IS DISTINCT FROM OLD.payload_ref OR NEW.payload_preview IS DISTINCT FROM OLD.payload_preview OR NEW.attachments IS DISTINCT FROM OLD.attachments OR NEW.actor_id <> OLD.actor_id OR NEW.body_digest <> OLD.body_digest OR NEW.created_at <> OLD.created_at OR NEW.ledger_sequence < OLD.ledger_sequence THEN RAISE EXCEPTION 'deployments.messaging_messages is append-only except the guarded delivery projection (message %)', OLD.id; END IF; IF OLD.delivery_status IN ('delivered','undelivered') THEN RAISE EXCEPTION 'deployments.messaging_messages delivery status is terminal-immutable in state % (message %)', OLD.delivery_status, OLD.id; END IF; IF NOT ( (OLD.delivery_status IS NULL AND NEW.delivery_status IN ('pending','sent','delivered','undelivered')) OR (OLD.delivery_status = 'pending' AND NEW.delivery_status IN ('sent','delivered','undelivered')) OR (OLD.delivery_status = 'sent' AND NEW.delivery_status IN ('delivered','undelivered')) OR (OLD.delivery_status = NEW.delivery_status) ) THEN RAISE EXCEPTION 'messaging message % delivery status cannot regress from % to % (the frozen monotonic delivery vocabulary)', OLD.id, OLD.delivery_status, NEW.delivery_status; END IF; IF (NEW.delivery_status = OLD.delivery_status) AND (NEW.delivered_at IS DISTINCT FROM OLD.delivered_at OR NEW.ledger_sequence IS DISTINCT FROM OLD.ledger_sequence) AND OLD.delivery_status IS NOT NULL THEN RAISE EXCEPTION 'messaging message % delivery projection is immutable at the same status', OLD.id; END IF; RETURN NEW; ELSE RAISE EXCEPTION 'deployments.messaging_messages is append-only (message % — only agent-reply rows carry the delivery projection)', OLD.id; END IF; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_messages_append_only_guard
    BEFORE UPDATE ON deployments.messaging_messages
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_messages_append_only();

CREATE OR REPLACE FUNCTION deployments.msg_messages_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.messaging_messages rows are never deleted (message %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_messages_no_delete_guard
    BEFORE DELETE ON deployments.messaging_messages
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_messages_no_delete();

-- Attachments are ARTIFACT REFERENCES only: every element must be a
-- string reference of at most 512 characters (embedded binary payloads
-- are physically unrepresentable — the work order's "large
-- attachments through artifact/object references" rule).
CREATE OR REPLACE FUNCTION deployments.msg_messages_attachments_refs() RETURNS trigger AS $$ DECLARE element jsonb; BEGIN IF NEW.attachments IS NULL THEN RETURN NEW; END IF; IF jsonb_typeof(NEW.attachments) <> 'array' THEN RAISE EXCEPTION 'messaging message attachments must be a jsonb array (message %)', NEW.id; END IF; FOR element IN SELECT jsonb_array_elements(NEW.attachments) LOOP IF jsonb_typeof(element) <> 'string' THEN RAISE EXCEPTION 'messaging message attachments must be artifact-reference strings (message %)', NEW.id; END IF; IF length(element #>> '{}') > 512 THEN RAISE EXCEPTION 'messaging message attachment reference exceeds 512 characters (message %)', NEW.id; END IF; END LOOP; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_messages_attachments_refs_guard
    BEFORE INSERT OR UPDATE OF attachments ON deployments.messaging_messages
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_messages_attachments_refs();

-- ---------------------------------------------------------------------------
-- The append-only delivery-callback evidence ledger (MOD-009: delivery
-- state is evidence/provenance). One row per applied callback;
-- duplicates converge on the physical UNIQUE; the trigger guarantees
-- the row references an agent-reply of the same conversation whose
-- recorded channel reference matches (a callback cannot evidence the
-- wrong message).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.messaging_deliveries (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    conversation_id uuid NOT NULL,
    deployment_id uuid NOT NULL,
    message_id    uuid NOT NULL,
    execution_id  uuid,
    callback_key  text NOT NULL,
    channel_message_ref text NOT NULL,
    from_status   text NOT NULL,
    to_status     text NOT NULL,
    detail        text,
    ledger_sequence bigint,
    actor_id      uuid NOT NULL,
    event_seq     bigint GENERATED ALWAYS AS IDENTITY,
    created_at    timestamptz NOT NULL,
    CONSTRAINT msg_deliveries_status_vocabulary CHECK (from_status IN ('pending','sent','delivered','undelivered') AND to_status IN ('sent','delivered','undelivered')),
    CONSTRAINT msg_deliveries_detail_bounded CHECK (detail IS NULL OR length(detail) <= 2000),
    CONSTRAINT msg_deliveries_key_nonempty CHECK (length(callback_key) BETWEEN 1 AND 200),
    CONSTRAINT msg_deliveries_ref_bounded CHECK (length(channel_message_ref) BETWEEN 1 AND 200),
    CONSTRAINT msg_deliveries_key_unique UNIQUE (application_id, conversation_id, callback_key),
    CONSTRAINT msg_deliveries_sequence_positive CHECK (ledger_sequence IS NULL OR ledger_sequence >= 1),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT msg_deliveries_conversation_fk FOREIGN KEY (conversation_id)
        REFERENCES deployments.messaging_conversations (id),
    CONSTRAINT msg_deliveries_message_fk FOREIGN KEY (message_id)
        REFERENCES deployments.messaging_messages (id)
);

CREATE INDEX msg_deliveries_conversation_order
    ON deployments.messaging_deliveries (application_id, conversation_id, event_seq);

CREATE OR REPLACE FUNCTION deployments.msg_deliveries_correlated() RETURNS trigger AS $$ DECLARE message_kind text; message_direction text; message_ref text; message_conversation uuid; BEGIN SELECT kind, direction, channel_message_ref, conversation_id INTO message_kind, message_direction, message_ref, message_conversation FROM deployments.messaging_messages WHERE id = NEW.message_id AND application_id = NEW.application_id; IF message_kind IS NULL THEN RAISE EXCEPTION 'messaging delivery references unknown message %', NEW.message_id; END IF; IF message_kind <> 'agent-reply' OR message_direction <> 'outbound' THEN RAISE EXCEPTION 'messaging delivery % must reference an outbound agent-reply (message % is %/%)', NEW.id, NEW.message_id, message_kind, message_direction; END IF; IF message_conversation <> NEW.conversation_id THEN RAISE EXCEPTION 'messaging delivery % references message % of another conversation (callback correlation violation)', NEW.id, NEW.message_id; END IF; IF NEW.channel_message_ref IS DISTINCT FROM message_ref THEN RAISE EXCEPTION 'messaging delivery % channel reference % does not match the originating send % (callback correlation violation)', NEW.id, NEW.channel_message_ref, message_ref; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_deliveries_correlated_guard
    BEFORE INSERT ON deployments.messaging_deliveries
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_deliveries_correlated();

CREATE OR REPLACE FUNCTION deployments.msg_deliveries_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.messaging_deliveries is append-only (delivery %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_deliveries_append_only_guard
    BEFORE UPDATE OR DELETE ON deployments.messaging_deliveries
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_deliveries_append_only();

-- ---------------------------------------------------------------------------
-- The immutable human-escalation records (AC7: escalation is a
-- governed Execution step — the wait-human linkage + the notice
-- delivery facts, durably recorded).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.messaging_escalations (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    conversation_id uuid NOT NULL,
    deployment_id  uuid NOT NULL,
    execution_id   uuid NOT NULL,
    escalation_key text NOT NULL,
    destination    text NOT NULL,
    cause          text,
    wait_sequence  bigint NOT NULL,
    notified_at    timestamptz,
    created_at     timestamptz NOT NULL,
    CONSTRAINT msg_escalations_key_nonempty CHECK (length(escalation_key) BETWEEN 1 AND 200),
    CONSTRAINT msg_escalations_destination_bounded CHECK (length(destination) BETWEEN 1 AND 200),
    CONSTRAINT msg_escalations_cause_bounded CHECK (cause IS NULL OR length(cause) <= 2000),
    CONSTRAINT msg_escalations_wait_sequence_positive CHECK (wait_sequence >= 1),
    CONSTRAINT msg_escalations_key_unique UNIQUE (application_id, escalation_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT msg_escalations_conversation_fk FOREIGN KEY (conversation_id)
        REFERENCES deployments.messaging_conversations (id),
    CONSTRAINT msg_escalations_deployment_fk FOREIGN KEY (deployment_id)
        REFERENCES deployments.deployments (id)
);

CREATE INDEX msg_escalations_conversation_listing
    ON deployments.messaging_escalations (application_id, conversation_id, created_at);

-- The record is write-once (an escalation's destination, cause, wait
-- linkage and notice facts never move).
CREATE OR REPLACE FUNCTION deployments.msg_escalations_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.messaging_escalations is write-once (escalation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_escalations_immutable_guard
    BEFORE UPDATE OR DELETE ON deployments.messaging_escalations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_escalations_immutable();

-- ---------------------------------------------------------------------------
-- The durable, recoverable messaging OPERATION state (the WORK-024
-- crash-safety standard). One row per governed rail-side effect:
-- PENDING (claimed, not durably complete — a crash in the
-- claim/completion window leaves this; a retry MUST resume with the
-- STABLE rail-level idempotency key) -> COMPLETED (the durable
-- outcome exists; replays return it with no side effect) | FAILED (a
-- durably recorded terminal failure outcome — the rail refused).
-- ---------------------------------------------------------------------------

CREATE TABLE deployments.messaging_operations (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    -- Provenance reference WITHOUT FK by design: a conversation-start
    -- operation row is durably claimed BEFORE the conversation row
    -- exists (that ordering is exactly the crash window this ledger
    -- closes).
    conversation_id uuid,
    deployment_id  uuid NOT NULL,
    execution_id   uuid,
    operation_kind text NOT NULL,
    operation_key  text NOT NULL,
    status         text NOT NULL,
    attempts       integer NOT NULL DEFAULT 1,
    -- Bounded stage checkpoint (the past-the-point-of-no-return facts a
    -- crash-resume completes from; never payloads, never secrets).
    checkpoint     jsonb,
    failure_reason text,
    created_at     timestamptz NOT NULL,
    updated_at     timestamptz NOT NULL,
    completed_at   timestamptz,
    CONSTRAINT msg_ops_kind_vocabulary CHECK (operation_kind IN ('conversation-start','turn-reply','delivery-apply','human-escalation','conversation-close')),
    CONSTRAINT msg_ops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT msg_ops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT msg_ops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT msg_ops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT msg_ops_checkpoint_bounded CHECK (checkpoint IS NULL OR pg_column_size(checkpoint) <= 4096),
    CONSTRAINT msg_ops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT msg_ops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT msg_ops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT msg_ops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT msg_ops_key_unique UNIQUE (application_id, operation_key),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX msg_ops_conversation_listing
    ON deployments.messaging_operations (application_id, conversation_id, created_at);

CREATE INDEX msg_ops_pending_scan
    ON deployments.messaging_operations (application_id, status, updated_at)
    WHERE status = 'pending';

-- The identity core is write-once: application/tenant/deployment
-- binding, the operation kind and key, the conversation/execution
-- provenance references and the creation timestamp never move.
CREATE OR REPLACE FUNCTION deployments.msg_ops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.deployment_id <> OLD.deployment_id OR NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'deployments.messaging_operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_ops_core_guard
    BEFORE UPDATE ON deployments.messaging_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_ops_core_immutable();

-- The recoverable status machine: only PENDING may move (to COMPLETED
-- or FAILED, with the outcome fields set atomically); COMPLETED/FAILED
-- are terminal-immutable (checkpoint/failure/reason/timestamps
-- frozen); attempts never regress. A physical UPDATE of a terminal row
-- is unrepresentable.
CREATE OR REPLACE FUNCTION deployments.msg_ops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'deployments.messaging_operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) THEN RAISE EXCEPTION 'messaging operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_ops_lifecycle_guard
    BEFORE UPDATE ON deployments.messaging_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_ops_lifecycle();

CREATE OR REPLACE FUNCTION deployments.msg_ops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'deployments.messaging_operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER msg_ops_no_delete_guard
    BEFORE DELETE ON deployments.messaging_operations
    FOR EACH ROW EXECUTE FUNCTION deployments.msg_ops_no_delete();
