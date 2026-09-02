-- WORK-029 — Edge, real-time and embodied execution integration
-- (EDGE-001/002/003).
--
-- The durable state of the governed edge fabric: tenant-scoped REVOCABLE
-- device identities with capability evidence and health metadata, the
-- human-approval ledger (subject-fingerprint bound, decisions
-- terminal-immutable), the IMMUTABLE safety envelopes (admitted only
-- through the authority chain; superseded only by a NEW authorized
-- admission; fail-safe revocation that only tightens), the keyed COMMAND
-- journal (gapless per-device authoritative sequence INCLUDING denied
-- requests, write-once ledger bindings), the append-only ACTUATION
-- provenance ledger (commanded / envelope-autonomous / violation), the
-- append-only SENSOR observation ledger (retention classes, ephemeral
-- rows carry no content), the RECONCILIATION records (deterministic
-- conflict-safe reconnect convergence) and the DURABLE, RECOVERABLE
-- OPERATION STATE (the WORK-024 crash-safety standard: PENDING ->
-- COMPLETED|FAILED, stable keys, monotonic attempts, stage checkpoints,
-- terminal immutability).
--
-- ARCHITECTURE PRESERVATION (the Work Order's invariants):
--   * Zeck is the governance/orchestration plane, NOT the
--     safety-critical control loop: these tables store governance state
--     ONLY — envelopes, commands, provenance, reconciliations. NO
--     scheduling, ticking or loop state exists anywhere in this schema
--     (there is no column and no table for control-loop cadence; the
--     local substrate owns hard real time behind its own controller);
--   * every execution-bound row references the EXISTING execution
--     identity through the composite key (execution_id, application_id)
--     -> executions.executions and (application_id, tenant_id) ->
--     applications.applications — there is NO second execution identity
--     and NO second lifecycle here; execution status is NEVER written by
--     this schema's triggers or tables. Edge provenance rides the
--     CANONICAL EventEnvelope ledger through the frozen recordStepEvent
--     seam (the tools producer vocabulary tool-requested / tool-result /
--     tool-denied); the human gate manifests on the executions lifecycle
--     ONLY through the public wait-human / resume transition commands;
--   * physical invariants: the envelope CONTENT is immutable
--     post-admission (the content digest is pinned at insert; the only
--     stored moves are an authorized supersede — a NEW row linked to the
--     old one — and an authorized revocation); device identities are
--     tenant-scoped and revocation is TERMINAL (never resurrected);
--     stale/unauthorized commands cannot reach the actuator path (the
--     denied rows are pure admission evidence with ZERO dispatch
--     columns); commanded actuations settle exactly once (keyed digest
--     arbitration); the authoritative command stream is gapless per
--     device and strictly ASCENDS on the actuator path.
--
-- Migration-version discipline (the collision rule, parallel wave-6):
-- the live inventory at authoring time is 0001..0014, 0016..0023 (0015
-- is BURNED — WORK-019's owned number, absent from the tree; 0023 =
-- WORK-027, merged in the frozen base). **WORK-029 claims 0024 — THIS
-- migration. No other unmerged Work Order claims 0024.** (Convention
-- pinned in docs/work-items/WORK-018.md § migration discipline.)
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — every trigger function body below is a single
-- line with no embedded `;` line endings.

CREATE SCHEMA IF NOT EXISTS edge;

-- ---------------------------------------------------------------------------
-- Devices: tenant-scoped, revocable identities with health metadata
-- ---------------------------------------------------------------------------

CREATE TABLE edge.devices (
    id                    uuid PRIMARY KEY,
    application_id        uuid NOT NULL,
    tenant_id             uuid NOT NULL,
    device_key            text NOT NULL,
    request_fingerprint   text NOT NULL,
    label                 text NOT NULL,
    workload_classes      jsonb NOT NULL,
    capability_atoms      jsonb NOT NULL,
    controller_ref        text NOT NULL,
    status                text NOT NULL,
    health                jsonb,
    last_command_sequence integer NOT NULL DEFAULT 0,
    last_dispatched_sequence integer NOT NULL DEFAULT 0,
    created_at            timestamptz NOT NULL,
    revoked_at            timestamptz,
    revocation_reason     text,
    CONSTRAINT ed_device_key_bounded CHECK (length(device_key) BETWEEN 1 AND 200),
    CONSTRAINT ed_device_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT ed_device_label_bounded CHECK (length(label) BETWEEN 1 AND 200),
    CONSTRAINT ed_device_controller_bounded CHECK (length(controller_ref) BETWEEN 1 AND 200),
    CONSTRAINT ed_device_status_vocabulary CHECK (status IN ('registered','revoked')),
    CONSTRAINT ed_device_workload_shape CHECK (jsonb_typeof(workload_classes) = 'array'),
    CONSTRAINT ed_device_atoms_shape CHECK (jsonb_typeof(capability_atoms) = 'array'),
    CONSTRAINT ed_device_health_shape CHECK (health IS NULL OR (jsonb_typeof(health) = 'object' AND (health->>'status') IN ('healthy','degraded','unreachable'))),
    CONSTRAINT ed_device_revocation_shape CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
        OR (status = 'registered' AND revoked_at IS NULL AND revocation_reason IS NULL)
    ),
    CONSTRAINT ed_device_revocation_reason_bounded CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 500),
    CONSTRAINT ed_device_sequences_nonnegative CHECK (last_command_sequence >= 0 AND last_dispatched_sequence >= 0),
    CONSTRAINT ed_device_dispatched_within_stream CHECK (last_dispatched_sequence <= last_command_sequence),
    CONSTRAINT ed_device_key_unique UNIQUE (application_id, device_key),
    CONSTRAINT ed_device_identity_unique UNIQUE (id, application_id),
    CONSTRAINT ed_device_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX ed_devices_by_application
    ON edge.devices (application_id, status, created_at);

-- The identity core is write-once: the tenant binding, the device key,
-- the request fingerprint, the declared evidence and the opaque
-- controller reference never move. Health metadata and the stream
-- sequence counters are the ONLY mutable bookkeeping.
CREATE OR REPLACE FUNCTION edge.ed_devices_core_guard() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.device_key <> OLD.device_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.label <> OLD.label OR (NEW.workload_classes)::text <> (OLD.workload_classes)::text OR (NEW.capability_atoms)::text <> (OLD.capability_atoms)::text OR NEW.controller_ref <> OLD.controller_ref OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'edge.devices identity core is immutable (device %)', OLD.id; END IF; IF OLD.status = 'revoked' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'edge device % is revoked (terminal-immutable)', OLD.id; END IF; IF OLD.status = 'registered' AND NEW.status NOT IN ('registered','revoked') THEN RAISE EXCEPTION 'edge device % cannot move from registered to %', OLD.id, NEW.status; END IF; IF OLD.status = 'registered' AND NEW.status = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL) THEN RAISE EXCEPTION 'edge device % revocation requires revoked_at and a reason', OLD.id; END IF; IF NEW.last_command_sequence < OLD.last_command_sequence OR NEW.last_dispatched_sequence < OLD.last_dispatched_sequence OR NEW.last_dispatched_sequence > NEW.last_command_sequence THEN RAISE EXCEPTION 'edge device % sequence counters are monotonic and dispatched never exceeds the stream', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_devices_core_guard
    BEFORE UPDATE ON edge.devices
    FOR EACH ROW EXECUTE FUNCTION edge.ed_devices_core_guard();

CREATE OR REPLACE FUNCTION edge.ed_devices_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.devices rows are never deleted (device %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_devices_no_delete_guard
    BEFORE DELETE ON edge.devices
    FOR EACH ROW EXECUTE FUNCTION edge.ed_devices_no_delete();

-- ---------------------------------------------------------------------------
-- Device health reports (append-only evidence; the device row denormalizes)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.device_health_reports (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    device_id      uuid NOT NULL,
    status         text NOT NULL,
    metrics        jsonb NOT NULL,
    note           text,
    reported_at    timestamptz NOT NULL,
    CONSTRAINT ed_health_status_vocabulary CHECK (status IN ('healthy','degraded','unreachable')),
    CONSTRAINT ed_health_metrics_shape CHECK (jsonb_typeof(metrics) = 'object'),
    CONSTRAINT ed_health_note_bounded CHECK (note IS NULL OR length(note) <= 2000),
    CONSTRAINT ed_health_identity_unique UNIQUE (id, application_id),
    CONSTRAINT ed_health_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id),
    CONSTRAINT ed_health_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX ed_health_by_device
    ON edge.device_health_reports (application_id, device_id, reported_at);

CREATE OR REPLACE FUNCTION edge.ed_health_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.device_health_reports is append-only (rejected % on report %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_health_no_mutation
    BEFORE UPDATE OR DELETE ON edge.device_health_reports
    FOR EACH ROW EXECUTE FUNCTION edge.ed_health_append_only();

-- ---------------------------------------------------------------------------
-- The human-approval ledger (subject-fingerprint bound; decisions
-- terminal-immutable; ledger bindings write-once)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.approvals (
    id                    uuid PRIMARY KEY,
    application_id        uuid NOT NULL,
    tenant_id             uuid NOT NULL,
    execution_id          uuid NOT NULL,
    device_id             uuid NOT NULL,
    subject_kind          text NOT NULL,
    subject_fingerprint   text NOT NULL,
    policy_basis          text NOT NULL,
    status                text NOT NULL,
    approval_key          text NOT NULL,
    requested_at          timestamptz NOT NULL,
    decided_at            timestamptz,
    approver_id           text,
    decision              text,
    expires_at            timestamptz,
    ledger_wait_sequence  integer,
    ledger_resume_sequence integer,
    CONSTRAINT ed_approval_kind_vocabulary CHECK (subject_kind IN ('envelope','command')),
    CONSTRAINT ed_approval_status_vocabulary CHECK (status IN ('pending','approved','denied','expired')),
    CONSTRAINT ed_approval_decision_vocabulary CHECK (decision IS NULL OR decision IN ('approved','denied')),
    CONSTRAINT ed_approval_key_bounded CHECK (length(approval_key) BETWEEN 1 AND 200),
    CONSTRAINT ed_approval_fingerprint_bounded CHECK (length(subject_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT ed_approval_basis_bounded CHECK (length(policy_basis) BETWEEN 1 AND 500),
    CONSTRAINT ed_approval_approver_bounded CHECK (approver_id IS NULL OR length(approver_id) BETWEEN 1 AND 200),
    CONSTRAINT ed_approval_pending_shape CHECK (
        (status = 'pending' AND decided_at IS NULL AND approver_id IS NULL AND decision IS NULL)
        OR (status <> 'pending' AND decided_at IS NOT NULL AND (approver_id IS NULL OR length(approver_id) >= 1))
    ),
    CONSTRAINT ed_approval_decision_shape CHECK (
        (status IN ('approved','denied') AND decision = status AND approver_id IS NOT NULL)
        OR (status IN ('pending','expired') AND decision IS NULL AND approver_id IS NULL)
    ),
    CONSTRAINT ed_approval_key_unique UNIQUE (application_id, approval_key),
    CONSTRAINT ed_approval_identity_unique UNIQUE (id, application_id),
    CONSTRAINT ed_approval_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT ed_approval_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT ed_approval_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id)
);

CREATE INDEX ed_approvals_by_execution
    ON edge.approvals (application_id, execution_id, requested_at);

CREATE INDEX ed_approvals_by_device
    ON edge.approvals (application_id, device_id, requested_at);

-- The identity core is write-once: the binding chain (tenant, execution,
-- device, subject kind, subject fingerprint, policy basis, key, expiry)
-- never moves.
CREATE OR REPLACE FUNCTION edge.ed_approvals_core_guard() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.device_id <> OLD.device_id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_fingerprint <> OLD.subject_fingerprint OR NEW.policy_basis <> OLD.policy_basis OR NEW.approval_key <> OLD.approval_key OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'edge.approvals identity core is immutable (approval %)', OLD.id; END IF; IF OLD.ledger_wait_sequence IS NOT NULL AND NEW.ledger_wait_sequence IS DISTINCT FROM OLD.ledger_wait_sequence THEN RAISE EXCEPTION 'edge approval % wait-human ledger binding is write-once', OLD.id; END IF; IF OLD.ledger_resume_sequence IS NOT NULL AND NEW.ledger_resume_sequence IS DISTINCT FROM OLD.ledger_resume_sequence THEN RAISE EXCEPTION 'edge approval % resume ledger binding is write-once', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_approvals_core_guard
    BEFORE UPDATE ON edge.approvals
    FOR EACH ROW EXECUTE FUNCTION edge.ed_approvals_core_guard();

-- The decision machine: pending -> approved|denied|expired exactly once;
-- the DECISION columns are terminal-immutable (the write-once ledger
-- sequence bindings remain writable on a decided row — the core guard
-- pins them write-once; the service binds the resume transition AFTER
-- the decision applies, exactly the crash-window discipline).
CREATE OR REPLACE FUNCTION edge.ed_approvals_lifecycle_guard() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('approved','denied','expired') AND (NEW.status <> OLD.status OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.decision IS DISTINCT FROM OLD.decision) THEN RAISE EXCEPTION 'edge approval % decision is terminal-immutable in status %', OLD.id, OLD.status; END IF; IF OLD.status = 'pending' AND NEW.status NOT IN ('pending','approved','denied','expired') THEN RAISE EXCEPTION 'edge approval % cannot move from pending to %', OLD.id, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_approvals_lifecycle_guard
    BEFORE UPDATE ON edge.approvals
    FOR EACH ROW EXECUTE FUNCTION edge.ed_approvals_lifecycle_guard();

CREATE OR REPLACE FUNCTION edge.ed_approvals_insert_gate() RETURNS trigger AS $$ BEGIN IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'edge approvals are inserted pending only (got %)', NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_approvals_insert_gate
    BEFORE INSERT ON edge.approvals
    FOR EACH ROW EXECUTE FUNCTION edge.ed_approvals_insert_gate();

CREATE OR REPLACE FUNCTION edge.ed_approvals_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.approvals rows are never deleted (approval %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_approvals_no_delete_guard
    BEFORE DELETE ON edge.approvals
    FOR EACH ROW EXECUTE FUNCTION edge.ed_approvals_no_delete();

-- ---------------------------------------------------------------------------
-- The safety envelopes (IMMUTABLE once admitted; superseded only by a
-- new authorized admission; fail-safe revocation)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.envelopes (
    id                       uuid PRIMARY KEY,
    application_id           uuid NOT NULL,
    tenant_id                uuid NOT NULL,
    execution_id             uuid NOT NULL,
    device_id                uuid NOT NULL,
    envelope_key             text NOT NULL,
    request_fingerprint      text NOT NULL,
    content_digest           text NOT NULL,
    content                  jsonb NOT NULL,
    status                   text NOT NULL,
    admission                jsonb NOT NULL,
    supersedes_envelope_id   uuid,
    superseded_by_envelope_id uuid,
    command_count            integer NOT NULL DEFAULT 0,
    created_at               timestamptz NOT NULL,
    superseded_at            timestamptz,
    revoked_at               timestamptz,
    revocation_reason        text,
    CONSTRAINT ed_envelope_key_bounded CHECK (length(envelope_key) BETWEEN 1 AND 200),
    CONSTRAINT ed_envelope_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT ed_envelope_digest_shape CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ed_envelope_status_vocabulary CHECK (status IN ('admitted','superseded','revoked')),
    CONSTRAINT ed_envelope_content_object CHECK (jsonb_typeof(content) = 'object'),
    CONSTRAINT ed_envelope_content_channels CHECK (jsonb_typeof(content->'channels') = 'array'),
    CONSTRAINT ed_envelope_content_policy CHECK (content->>'disconnectedPolicy' IN ('hold','continue-within-envelope')),
    CONSTRAINT ed_envelope_admission_object CHECK (jsonb_typeof(admission) = 'object'),
    CONSTRAINT ed_envelope_command_count_nonnegative CHECK (command_count >= 0),
    CONSTRAINT ed_envelope_superseded_shape CHECK (
        (status = 'superseded' AND superseded_at IS NOT NULL AND superseded_by_envelope_id IS NOT NULL)
        OR (status <> 'superseded' AND superseded_at IS NULL AND superseded_by_envelope_id IS NULL)
    ),
    CONSTRAINT ed_envelope_revoked_shape CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
        OR (status <> 'revoked' AND revoked_at IS NULL AND revocation_reason IS NULL)
    ),
    CONSTRAINT ed_envelope_revocation_reason_bounded CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 500),
    CONSTRAINT ed_envelope_command_budget CHECK (command_count <= COALESCE((content->>'maxCommands')::int, 100000)),
    CONSTRAINT ed_envelope_key_unique UNIQUE (application_id, envelope_key),
    CONSTRAINT ed_envelope_identity_unique UNIQUE (id, application_id),
    CONSTRAINT ed_envelope_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT ed_envelope_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT ed_envelope_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id),
    CONSTRAINT ed_envelope_supersedes_fk
        FOREIGN KEY (supersedes_envelope_id, application_id)
        REFERENCES edge.envelopes (id, application_id),
    CONSTRAINT ed_envelope_superseded_by_fk
        FOREIGN KEY (superseded_by_envelope_id, application_id)
        REFERENCES edge.envelopes (id, application_id)
);

CREATE INDEX ed_envelopes_by_device
    ON edge.envelopes (application_id, device_id, created_at);

CREATE INDEX ed_envelopes_active
    ON edge.envelopes (application_id, device_id, created_at DESC)
    WHERE status = 'admitted';

CREATE INDEX ed_envelopes_by_execution
    ON edge.envelopes (application_id, execution_id, created_at);

-- The identity core is write-once: the binding chain, the envelope key,
-- the request fingerprint, the CONTENT and its digest, the admission
-- bundle and the supersede link never move. THE SAFETY ENVELOPE IS
-- IMMUTABLE ONCE ADMITTED — the only stored moves are an authorized
-- supersede (status + superseded_by, set by the superseding admission)
-- and an authorized revocation.
CREATE OR REPLACE FUNCTION edge.ed_envelopes_core_guard() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.device_id <> OLD.device_id OR NEW.envelope_key <> OLD.envelope_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.content_digest <> OLD.content_digest OR (NEW.content)::text <> (OLD.content)::text OR (NEW.admission)::text <> (OLD.admission)::text OR NEW.supersedes_envelope_id IS DISTINCT FROM OLD.supersedes_envelope_id OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'edge.envelopes identity core (incl. the envelope CONTENT) is immutable (envelope %)', OLD.id; END IF; IF OLD.superseded_by_envelope_id IS NOT NULL AND NEW.superseded_by_envelope_id IS DISTINCT FROM OLD.superseded_by_envelope_id THEN RAISE EXCEPTION 'edge envelope % superseded-by binding is write-once', OLD.id; END IF; IF NEW.command_count < OLD.command_count THEN RAISE EXCEPTION 'edge envelope % command count never regresses', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_envelopes_core_guard
    BEFORE UPDATE ON edge.envelopes
    FOR EACH ROW EXECUTE FUNCTION edge.ed_envelopes_core_guard();

-- The guarded lifecycle: admitted -> superseded|revoked exactly once;
-- terminal rows fully immutable.
CREATE OR REPLACE FUNCTION edge.ed_envelopes_lifecycle_guard() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('superseded','revoked') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'edge envelope % is terminal-immutable in status %', OLD.id, OLD.status; END IF; IF OLD.status = 'admitted' AND NEW.status NOT IN ('admitted','superseded','revoked') THEN RAISE EXCEPTION 'edge envelope % cannot move from admitted to %', OLD.id, NEW.status; END IF; IF OLD.status = 'admitted' AND NEW.status = 'admitted' AND (NEW.superseded_at IS NOT NULL OR NEW.revoked_at IS NOT NULL) THEN RAISE EXCEPTION 'an admitted edge envelope cannot carry terminal evidence (envelope %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_envelopes_lifecycle_guard
    BEFORE UPDATE ON edge.envelopes
    FOR EACH ROW EXECUTE FUNCTION edge.ed_envelopes_lifecycle_guard();

CREATE OR REPLACE FUNCTION edge.ed_envelopes_insert_gate() RETURNS trigger AS $$ BEGIN IF NEW.status <> 'admitted' THEN RAISE EXCEPTION 'edge envelopes are inserted admitted only (got %)', NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_envelopes_insert_gate
    BEFORE INSERT ON edge.envelopes
    FOR EACH ROW EXECUTE FUNCTION edge.ed_envelopes_insert_gate();

CREATE OR REPLACE FUNCTION edge.ed_envelopes_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.envelopes rows are never deleted (envelope %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ed_envelopes_no_delete_guard
    BEFORE DELETE ON edge.envelopes
    FOR EACH ROW EXECUTE FUNCTION edge.ed_envelopes_no_delete();

-- ---------------------------------------------------------------------------
-- The keyed command journal (the authoritative stream: gapless per
-- device INCLUDING denied requests; dispatch strictly ASCENDS)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.commands (
    id                       uuid PRIMARY KEY,
    application_id           uuid NOT NULL,
    tenant_id                uuid NOT NULL,
    execution_id             uuid NOT NULL,
    device_id                uuid NOT NULL,
    envelope_id              uuid NOT NULL,
    command_key              text NOT NULL,
    request_fingerprint      text NOT NULL,
    sequence                 integer NOT NULL,
    command_kind             text NOT NULL,
    effect_class             text NOT NULL,
    channel                  text NOT NULL,
    magnitude                integer NOT NULL,
    payload_digest           text NOT NULL,
    estimated_micro_usd      text NOT NULL DEFAULT '0',
    not_before               timestamptz NOT NULL,
    not_after                timestamptz NOT NULL,
    status                   text NOT NULL,
    denial_class             text,
    denial_reason            text,
    approval_id              uuid,
    failure_class            text,
    failure_message          text,
    dispatch_digest          text,
    usage_micro_usd          text,
    dispatched_at            timestamptz,
    settled_at               timestamptz,
    reconciled_at            timestamptz,
    created_at               timestamptz NOT NULL,
    ledger_requested_sequence integer,
    ledger_result_sequence   integer,
    CONSTRAINT ec_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT ec_command_key_bounded CHECK (length(command_key) BETWEEN 1 AND 200),
    CONSTRAINT ec_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT ec_kind_vocabulary CHECK (command_kind IN ('actuate','configure','halt','poll')),
    CONSTRAINT ec_effect_vocabulary CHECK (effect_class IN ('physical-write','device-config','telemetry-read')),
    CONSTRAINT ec_channel_vocabulary CHECK (channel IN ('locomotion','manipulation','process-control','signal','display')),
    CONSTRAINT ec_magnitude_scale CHECK (magnitude BETWEEN -1000 AND 1000),
    CONSTRAINT ec_payload_digest_shape CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ec_dispatch_digest_shape CHECK (dispatch_digest IS NULL OR dispatch_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ec_estimated_shape CHECK (estimated_micro_usd ~ '^[0-9]{1,16}$'),
    CONSTRAINT ec_usage_shape CHECK (usage_micro_usd IS NULL OR usage_micro_usd ~ '^[0-9]{1,19}$'),
    CONSTRAINT ec_status_vocabulary CHECK (status IN ('denied','authorized','dispatched','settled','failed','invalidated','conflicted')),
    CONSTRAINT ec_denial_vocabulary CHECK (denial_class IS NULL OR denial_class IN ('policy','capability','budget','approval','envelope','stale')),
    CONSTRAINT ec_denial_reason_bounded CHECK (denial_reason IS NULL OR length(denial_reason) <= 500),
    CONSTRAINT ec_failure_class_bounded CHECK (failure_class IS NULL OR length(failure_class) <= 200),
    CONSTRAINT ec_failure_message_bounded CHECK (failure_message IS NULL OR length(failure_message) <= 512),
    CONSTRAINT ec_window_ordered CHECK (not_after > not_before),
    CONSTRAINT ec_denied_shape CHECK (
        status <> 'denied' OR (denial_class IS NOT NULL AND denial_reason IS NOT NULL AND dispatched_at IS NULL AND dispatch_digest IS NULL AND usage_micro_usd IS NULL AND failure_class IS NULL AND settled_at IS NULL)
    ),
    CONSTRAINT ec_authorized_shape CHECK (
        status <> 'authorized' OR (dispatched_at IS NULL AND dispatch_digest IS NULL AND settled_at IS NULL AND failure_class IS NULL AND usage_micro_usd IS NULL)
    ),
    CONSTRAINT ec_dispatched_shape CHECK (
        status NOT IN ('dispatched','settled','conflicted') OR (dispatched_at IS NOT NULL AND dispatch_digest IS NOT NULL)
    ),
    CONSTRAINT ec_settled_shape CHECK (
        status <> 'settled' OR (settled_at IS NOT NULL AND reconciled_at IS NOT NULL AND usage_micro_usd IS NOT NULL)
    ),
    CONSTRAINT ec_conflicted_shape CHECK (
        status <> 'conflicted' OR reconciled_at IS NOT NULL
    ),
    CONSTRAINT ec_failed_shape CHECK (
        status NOT IN ('failed','invalidated') OR (failure_class IS NOT NULL AND settled_at IS NULL AND usage_micro_usd IS NULL)
    ),
    CONSTRAINT ec_terminal_no_dispatch_columns CHECK (
        status NOT IN ('denied','invalidated') OR (dispatched_at IS NULL AND dispatch_digest IS NULL)
    ),
    CONSTRAINT ec_key_unique UNIQUE (application_id, command_key),
    CONSTRAINT ec_sequence_unique UNIQUE (application_id, device_id, sequence),
    CONSTRAINT ec_identity_unique UNIQUE (id, application_id),
    CONSTRAINT ec_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT ec_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT ec_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id),
    CONSTRAINT ec_envelope_fk
        FOREIGN KEY (envelope_id, application_id)
        REFERENCES edge.envelopes (id, application_id),
    CONSTRAINT ec_approval_fk
        FOREIGN KEY (approval_id, application_id)
        REFERENCES edge.approvals (id, application_id)
);

CREATE INDEX ec_commands_by_device
    ON edge.commands (application_id, device_id, sequence);

CREATE INDEX ec_commands_by_envelope
    ON edge.commands (application_id, envelope_id, created_at);

CREATE INDEX ec_commands_by_execution
    ON edge.commands (application_id, execution_id, created_at);

CREATE INDEX ec_commands_pending_scan
    ON edge.commands (application_id, status, created_at)
    WHERE status = 'authorized';

-- The identity core is write-once: the binding chain, the key, the
-- fingerprint, the sequence, the command shape, the payload digest, the
-- window, the estimate and the creation timestamp never move. The
-- ledger-sequence bindings are write-once (NULL -> value, never moved).
CREATE OR REPLACE FUNCTION edge.ec_commands_core_guard() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.device_id <> OLD.device_id OR NEW.envelope_id <> OLD.envelope_id OR NEW.command_key <> OLD.command_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.sequence <> OLD.sequence OR NEW.command_kind <> OLD.command_kind OR NEW.effect_class <> OLD.effect_class OR NEW.channel <> OLD.channel OR NEW.magnitude <> OLD.magnitude OR NEW.payload_digest <> OLD.payload_digest OR NEW.estimated_micro_usd <> OLD.estimated_micro_usd OR NEW.not_before <> OLD.not_before OR NEW.not_after <> OLD.not_after OR NEW.approval_id IS DISTINCT FROM OLD.approval_id OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'edge.commands identity core is immutable (command %)', OLD.id; END IF; IF (OLD.ledger_requested_sequence IS NOT NULL AND NEW.ledger_requested_sequence IS DISTINCT FROM OLD.ledger_requested_sequence) OR (OLD.ledger_result_sequence IS NOT NULL AND NEW.ledger_result_sequence IS DISTINCT FROM OLD.ledger_result_sequence) THEN RAISE EXCEPTION 'edge command % ledger bindings are write-once', OLD.id; END IF; IF OLD.dispatch_digest IS NOT NULL AND NEW.dispatch_digest IS DISTINCT FROM OLD.dispatch_digest THEN RAISE EXCEPTION 'edge command % dispatch digest is write-once', OLD.id; END IF; IF OLD.denial_class IS NOT NULL AND (NEW.denial_class IS DISTINCT FROM OLD.denial_class OR NEW.denial_reason IS DISTINCT FROM OLD.denial_reason) THEN RAISE EXCEPTION 'edge command % denial evidence is write-once', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ec_commands_core_guard
    BEFORE UPDATE ON edge.commands
    FOR EACH ROW EXECUTE FUNCTION edge.ec_commands_core_guard();

-- The guarded lifecycle: terminal rows fully immutable; the only legal
-- moves are authorized -> dispatched|failed|invalidated and dispatched ->
-- settled|failed|conflicted (the crash-convergence window: a report of
-- the executed actuation finalizes the dispatch evidence).
CREATE OR REPLACE FUNCTION edge.ec_commands_lifecycle_guard() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('denied','settled','failed','invalidated','conflicted') AND (NEW.status <> OLD.status OR NEW.denial_class IS DISTINCT FROM OLD.denial_class OR NEW.denial_reason IS DISTINCT FROM OLD.denial_reason OR NEW.failure_class IS DISTINCT FROM OLD.failure_class OR NEW.failure_message IS DISTINCT FROM OLD.failure_message OR NEW.dispatch_digest IS DISTINCT FROM OLD.dispatch_digest OR NEW.usage_micro_usd IS DISTINCT FROM OLD.usage_micro_usd OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at) THEN RAISE EXCEPTION 'edge command % is terminal-immutable in status %', OLD.id, OLD.status; END IF; IF OLD.status = 'authorized' AND NEW.status NOT IN ('authorized','dispatched','failed','invalidated') THEN RAISE EXCEPTION 'edge command % cannot move from authorized to %', OLD.id, NEW.status; END IF; IF OLD.status = 'dispatched' AND NEW.status NOT IN ('dispatched','settled','failed','conflicted') THEN RAISE EXCEPTION 'edge command % cannot move from dispatched to %', OLD.id, NEW.status; END IF; IF OLD.status = 'authorized' AND NEW.status = 'authorized' AND (NEW.denial_class IS DISTINCT FROM OLD.denial_class OR NEW.denial_reason IS DISTINCT FROM OLD.denial_reason OR NEW.failure_class IS DISTINCT FROM OLD.failure_class OR NEW.failure_message IS DISTINCT FROM OLD.failure_message OR NEW.dispatch_digest IS DISTINCT FROM OLD.dispatch_digest OR NEW.usage_micro_usd IS DISTINCT FROM OLD.usage_micro_usd OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at) THEN RAISE EXCEPTION 'an authorized edge command has no mutable fields beyond the write-once ledger bindings (command %)', OLD.id; END IF; IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN RAISE EXCEPTION 'edge command % dispatch timestamp is write-once', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ec_commands_lifecycle_guard
    BEFORE UPDATE ON edge.commands
    FOR EACH ROW EXECUTE FUNCTION edge.ec_commands_lifecycle_guard();

-- The gapless authoritative sequence INCLUDING denied requests
-- (convergence-aware: a same-sequence/same-key duplicate passes to the
-- arbiter; a same-key/different-fingerprint insert fails closed).
CREATE OR REPLACE FUNCTION edge.ec_commands_sequence_gate() RETURNS trigger AS $$ DECLARE existing_key text; existing_fingerprint text; existing_seq integer; total integer; BEGIN SELECT command_key INTO existing_key FROM edge.commands WHERE application_id = NEW.application_id AND device_id = NEW.device_id AND sequence = NEW.sequence; IF existing_key IS NOT NULL THEN IF existing_key = NEW.command_key THEN RETURN NEW; END IF; RAISE EXCEPTION 'edge device % command sequence % already exists with a different key', NEW.device_id, NEW.sequence; END IF; SELECT request_fingerprint INTO existing_fingerprint FROM edge.commands WHERE application_id = NEW.application_id AND command_key = NEW.command_key; IF existing_fingerprint IS NOT NULL THEN IF existing_fingerprint = NEW.request_fingerprint THEN RETURN NEW; END IF; RAISE EXCEPTION 'edge command key % was already used with a different request (key reuse)', NEW.command_key; END IF; SELECT COUNT(*) INTO total FROM edge.commands WHERE application_id = NEW.application_id AND device_id = NEW.device_id; IF NEW.sequence IS DISTINCT FROM total + 1 THEN RAISE EXCEPTION 'edge device % command sequence must be gapless (expected %, got %)', NEW.device_id, total + 1, NEW.sequence; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ec_commands_sequence_gate
    BEFORE INSERT ON edge.commands
    FOR EACH ROW EXECUTE FUNCTION edge.ec_commands_sequence_gate();

-- The stream counters: every command (denied included) advances the
-- device's authoritative sequence; a dispatch ASCENDS the dispatched
-- watermark (never out-of-order authoritative dispatches).
CREATE OR REPLACE FUNCTION edge.ec_commands_after_insert() RETURNS trigger AS $$ BEGIN UPDATE edge.devices SET last_command_sequence = NEW.sequence WHERE application_id = NEW.application_id AND id = NEW.device_id AND last_command_sequence < NEW.sequence; UPDATE edge.envelopes SET command_count = command_count + 1 WHERE application_id = NEW.application_id AND id = NEW.envelope_id; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ec_commands_after_insert
    AFTER INSERT ON edge.commands
    FOR EACH ROW EXECUTE FUNCTION edge.ec_commands_after_insert();

CREATE OR REPLACE FUNCTION edge.ec_commands_after_update() RETURNS trigger AS $$ BEGIN IF NEW.status IN ('dispatched','settled') AND OLD.status = 'authorized' THEN UPDATE edge.devices SET last_dispatched_sequence = NEW.sequence WHERE application_id = NEW.application_id AND id = NEW.device_id AND last_dispatched_sequence < NEW.sequence; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ec_commands_after_update
    AFTER UPDATE ON edge.commands
    FOR EACH ROW EXECUTE FUNCTION edge.ec_commands_after_update();

CREATE OR REPLACE FUNCTION edge.ec_commands_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.commands rows are never deleted (command %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ec_commands_no_delete_guard
    BEFORE DELETE ON edge.commands
    FOR EACH ROW EXECUTE FUNCTION edge.ec_commands_no_delete();

-- ---------------------------------------------------------------------------
-- The reconciliation records (deterministic conflict-safe convergence)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.reconciliations (
    id               uuid PRIMARY KEY,
    application_id   uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    device_id        uuid NOT NULL,
    report_digest    text NOT NULL,
    status           text NOT NULL,
    confirmed_count  integer NOT NULL,
    autonomous_count integer NOT NULL,
    violation_count  integer NOT NULL,
    settled_count    integer NOT NULL,
    reconciled_at    timestamptz NOT NULL,
    CONSTRAINT er_status_vocabulary CHECK (status IN ('converged','conflict')),
    CONSTRAINT er_counts_nonnegative CHECK (confirmed_count >= 0 AND autonomous_count >= 0 AND violation_count >= 0 AND settled_count >= 0),
    CONSTRAINT er_report_digest_bounded CHECK (length(report_digest) BETWEEN 1 AND 8192),
    CONSTRAINT er_report_digest_unique UNIQUE (application_id, report_digest),
    CONSTRAINT er_identity_unique UNIQUE (id, application_id),
    CONSTRAINT er_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT er_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id)
);

CREATE INDEX er_reconciliations_by_device
    ON edge.reconciliations (application_id, device_id, reconciled_at);

CREATE OR REPLACE FUNCTION edge.er_reconciliations_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.reconciliations is append-only (rejected % on reconciliation %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER er_reconciliations_no_mutation
    BEFORE UPDATE OR DELETE ON edge.reconciliations
    FOR EACH ROW EXECUTE FUNCTION edge.er_reconciliations_append_only();

-- ---------------------------------------------------------------------------
-- The actuation provenance ledger (append-only: commanded /
-- envelope-autonomous / violation)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.actuation_events (
    id               uuid PRIMARY KEY,
    application_id   uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    execution_id     uuid,
    device_id        uuid NOT NULL,
    command_id       uuid,
    command_key      text,
    sequence         integer,
    actuation_class  text NOT NULL,
    violation_kind   text,
    channel          text,
    magnitude        integer,
    actuation_digest text NOT NULL,
    occurred_at      timestamptz NOT NULL,
    reconciled_at    timestamptz NOT NULL,
    reconciliation_id uuid,
    CONSTRAINT ea_class_vocabulary CHECK (actuation_class IN ('commanded','envelope-autonomous','violation')),
    CONSTRAINT ea_violation_vocabulary CHECK (violation_kind IS NULL OR violation_kind IN ('out-of-envelope','unauthorized-command','stale-execution','out-of-order','digest-mismatch')),
    CONSTRAINT ea_violation_shape CHECK ((actuation_class = 'violation') = (violation_kind IS NOT NULL)),
    CONSTRAINT ea_commanded_shape CHECK (
        (actuation_class = 'commanded' AND command_id IS NOT NULL AND command_key IS NOT NULL AND sequence IS NOT NULL)
        OR (actuation_class <> 'commanded' AND command_id IS NULL)
    ),
    CONSTRAINT ea_channel_vocabulary CHECK (channel IS NULL OR channel IN ('locomotion','manipulation','process-control','signal','display')),
    CONSTRAINT ea_magnitude_scale CHECK (magnitude IS NULL OR magnitude BETWEEN -1000 AND 1000),
    CONSTRAINT ea_digest_shape CHECK (actuation_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ea_digest_unique UNIQUE (application_id, device_id, actuation_digest),
    CONSTRAINT ea_identity_unique UNIQUE (id, application_id),
    CONSTRAINT ea_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT ea_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT ea_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id),
    CONSTRAINT ea_reconciliation_fk
        FOREIGN KEY (reconciliation_id, application_id)
        REFERENCES edge.reconciliations (id, application_id)
);

CREATE INDEX ea_actuations_by_device
    ON edge.actuation_events (application_id, device_id, occurred_at);

CREATE INDEX ea_actuations_violations
    ON edge.actuation_events (application_id, device_id, occurred_at)
    WHERE actuation_class = 'violation';

CREATE INDEX ea_actuations_by_command
    ON edge.actuation_events (application_id, command_id)
    WHERE command_id IS NOT NULL;

CREATE OR REPLACE FUNCTION edge.ea_actuations_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.actuation_events is append-only (rejected % on actuation %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER ea_actuations_no_mutation
    BEFORE UPDATE OR DELETE ON edge.actuation_events
    FOR EACH ROW EXECUTE FUNCTION edge.ea_actuations_append_only();

-- ---------------------------------------------------------------------------
-- The sensor observation ledger (append-only, keyed convergence, gapless
-- per-device sequence; ephemeral observations carry NO content)
-- ---------------------------------------------------------------------------

CREATE TABLE edge.sensor_observations (
    id               uuid PRIMARY KEY,
    application_id   uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    execution_id     uuid NOT NULL,
    device_id        uuid NOT NULL,
    sequence         integer NOT NULL,
    observation_key  text NOT NULL,
    observation_type text NOT NULL,
    retention        text NOT NULL,
    content_digest   text NOT NULL,
    content          text,
    observed_at      timestamptz NOT NULL,
    ledger_sequence  integer,
    CONSTRAINT es_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT es_observation_key_bounded CHECK (length(observation_key) BETWEEN 1 AND 200),
    CONSTRAINT es_type_vocabulary CHECK (observation_type IN ('telemetry','state','event','anomaly')),
    CONSTRAINT es_retention_vocabulary CHECK (retention IN ('retained','ephemeral')),
    CONSTRAINT es_digest_shape CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT es_content_shape CHECK ((retention = 'retained' AND content IS NOT NULL AND length(content) <= 16384) OR (retention = 'ephemeral' AND content IS NULL)),
    CONSTRAINT es_key_unique UNIQUE (application_id, observation_key),
    CONSTRAINT es_sequence_unique UNIQUE (application_id, device_id, sequence),
    CONSTRAINT es_identity_unique UNIQUE (id, application_id),
    CONSTRAINT es_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT es_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT es_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id)
);

CREATE INDEX es_observations_by_device
    ON edge.sensor_observations (application_id, device_id, sequence);

CREATE INDEX es_observations_by_execution
    ON edge.sensor_observations (application_id, execution_id, observed_at);

-- The gapless per-device sequence with the keyed convergence discipline:
-- a same-key/same-digest duplicate passes to the arbiter (ONE row
-- survives); a same-key/different-digest insert fails closed; a fresh
-- sequence must be exactly count+1.
CREATE OR REPLACE FUNCTION edge.es_observations_sequence_gate() RETURNS trigger AS $$ DECLARE existing_key text; existing_digest text; total integer; BEGIN SELECT content_digest INTO existing_digest FROM edge.sensor_observations WHERE application_id = NEW.application_id AND observation_key = NEW.observation_key; IF existing_digest IS NOT NULL THEN IF existing_digest = NEW.content_digest THEN RETURN NEW; END IF; RAISE EXCEPTION 'edge sensor observation key % was already used with different content (key reuse)', NEW.observation_key; END IF; SELECT COUNT(*) INTO total FROM edge.sensor_observations WHERE application_id = NEW.application_id AND device_id = NEW.device_id; IF NEW.sequence IS DISTINCT FROM total + 1 THEN RAISE EXCEPTION 'edge device % sensor observation sequence must be gapless (expected %, got %)', NEW.device_id, total + 1, NEW.sequence; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER es_observations_sequence_gate
    BEFORE INSERT ON edge.sensor_observations
    FOR EACH ROW EXECUTE FUNCTION edge.es_observations_sequence_gate();

-- The ledger binding is write-once (NULL -> value, never moved).
CREATE OR REPLACE FUNCTION edge.es_observations_ledger_guard() RETURNS trigger AS $$ BEGIN IF OLD.ledger_sequence IS NOT NULL AND NEW.ledger_sequence IS DISTINCT FROM OLD.ledger_sequence THEN RAISE EXCEPTION 'edge sensor observation % ledger binding is write-once', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER es_observations_ledger_guard
    BEFORE UPDATE ON edge.sensor_observations
    FOR EACH ROW EXECUTE FUNCTION edge.es_observations_ledger_guard();

CREATE OR REPLACE FUNCTION edge.es_observations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.sensor_observations rows are never deleted (observation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER es_observations_no_delete_guard
    BEFORE DELETE ON edge.sensor_observations
    FOR EACH ROW EXECUTE FUNCTION edge.es_observations_no_delete();

-- ---------------------------------------------------------------------------
-- The durable, recoverable OPERATION state (the WORK-024 crash-safety
-- standard). One row per governed edge side-effecting operation: PENDING
-- (claimed, not durably complete — a crash in the claim/completion window
-- leaves this; a retry MUST resume under the SAME stable key) ->
-- COMPLETED (the durable outcome exists; replays return it with no side
-- effect) | FAILED (a durably recorded terminal failure outcome — e.g. a
-- journaled admission denial).
-- ---------------------------------------------------------------------------

CREATE TABLE edge.operations (
    id                  uuid PRIMARY KEY,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    device_id           uuid,
    execution_id        uuid,
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
    CONSTRAINT eops_kind_vocabulary CHECK (operation_kind IN ('device-register','device-revoke','health-report','envelope-admit','envelope-revoke','command-submit','approval-request','approval-decide','sensor-ingest','reconcile')),
    CONSTRAINT eops_status_vocabulary CHECK (status IN ('pending','completed','failed')),
    CONSTRAINT eops_attempts_positive CHECK (attempts >= 1),
    CONSTRAINT eops_key_bounded CHECK (length(operation_key) BETWEEN 1 AND 200),
    CONSTRAINT eops_fingerprint_bounded CHECK (length(request_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT eops_failure_bounded CHECK (failure_reason IS NULL OR length(failure_reason) <= 512),
    CONSTRAINT eops_stage_bounded CHECK (stage IS NULL OR pg_column_size(stage) <= 4096),
    CONSTRAINT eops_completed_requires_timestamp CHECK (status <> 'completed' OR completed_at IS NOT NULL),
    CONSTRAINT eops_failed_requires_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT eops_pending_outcome_absent CHECK (status <> 'pending' OR (completed_at IS NULL AND failure_reason IS NULL)),
    CONSTRAINT eops_outcome_fields_exclusive CHECK (completed_at IS NULL OR failure_reason IS NULL),
    CONSTRAINT eops_key_unique UNIQUE (application_id, operation_key),
    CONSTRAINT eops_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT eops_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT eops_device_fk
        FOREIGN KEY (device_id, application_id)
        REFERENCES edge.devices (id, application_id)
);

CREATE INDEX eops_pending_scan
    ON edge.operations (application_id, status, updated_at)
    WHERE status = 'pending';

CREATE INDEX eops_device_listing
    ON edge.operations (application_id, device_id, created_at)
    WHERE device_id IS NOT NULL;

CREATE INDEX eops_execution_listing
    ON edge.operations (application_id, execution_id, created_at)
    WHERE execution_id IS NOT NULL;

-- The identity core is write-once: application/tenant binding, the
-- provenance references, the operation kind and key, the request
-- fingerprint and the creation timestamp never move.
CREATE OR REPLACE FUNCTION edge.eops_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.operation_kind <> OLD.operation_kind OR NEW.operation_key <> OLD.operation_key OR NEW.request_fingerprint <> OLD.request_fingerprint OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'edge.operations identity core is immutable (operation %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER eops_core_guard
    BEFORE UPDATE ON edge.operations
    FOR EACH ROW EXECUTE FUNCTION edge.eops_core_immutable();

-- The recoverable status machine: only PENDING may move (to COMPLETED or
-- FAILED, with the outcome fields set atomically); COMPLETED/FAILED are
-- terminal-immutable; attempts never regress; the stage checkpoint is
-- writable only while PENDING.
CREATE OR REPLACE FUNCTION edge.eops_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('completed','failed') THEN RAISE EXCEPTION 'edge.operations is terminal-immutable in state % (operation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('pending','completed','failed') OR (OLD.status = 'pending' AND NEW.status = 'pending' AND NEW.attempts < OLD.attempts) OR (NEW.status = 'completed' AND (NEW.completed_at IS NULL OR NEW.failure_reason IS NOT NULL)) OR (NEW.status = 'failed' AND (NEW.failure_reason IS NULL OR NEW.completed_at IS NOT NULL)) OR (NEW.status = 'pending' AND (NEW.completed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL)) THEN RAISE EXCEPTION 'edge operation % cannot move from status % to % (pending -> completed|failed only; completed/failed are terminal)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER eops_lifecycle_guard
    BEFORE UPDATE ON edge.operations
    FOR EACH ROW EXECUTE FUNCTION edge.eops_lifecycle();

CREATE OR REPLACE FUNCTION edge.eops_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'edge.operations rows are never deleted (operation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER eops_no_delete_guard
    BEFORE DELETE ON edge.operations
    FOR EACH ROW EXECUTE FUNCTION edge.eops_no_delete();
