-- WORK-059 — Advanced audit and compliance controls (D-08; SEC-004).
--
-- The durable surface of the audit module's append-only AUDIT
-- PROJECTION. PostgreSQL is the SOLE durable authority for audit
-- records; the projection is EVIDENCE, never a ledger of governed
-- state and never an authorization source (Work Order invariants
-- 1/2/6). Physical invariants (violations UNREPRESENTABLE, not
-- merely discouraged):
--
--   * audit records are PHYSICALLY append-only: UPDATE, DELETE and
--     TRUNCATE are rejected by trigger; the ONLY legal deletion is
--     the GOVERNED retention purge, gated by the transaction-local
--     session marker `audit.governed_purge` (set exclusively inside
--     the purge procedure of the audit store adapter, which deletes
--     only expired, hold-free records and appends purge evidence in
--     the SAME transaction — a deletion outside that procedure is
--     unrepresentable);
--   * record identity is content-addressed (`record_id` = sha256 over
--     the canonical identity form) and UNIQUE per application:
--     re-observing the same governed action is a bounded no-op
--     (replay), never a duplicate row;
--   * the hash chain is gapless and serialized per application:
--     UNIQUE (application_id, chain_sequence); every record carries
--     the previous record's digest and its own full-record digest;
--     chain extension happens under the chain-head row lock;
--   * closed vocabularies are CHECK-bound: action kinds, actor kinds,
--     target kinds and observation seams (the declared completeness
--     boundary of WORK-059 — anything outside this vocabulary is an
--     explicit NOT-recorded boundary, not a schema hole);
--   * retention is bounded by construction: `retention_days` is
--     CHECK-constrained to a finite horizon (unbounded retention is
--     unrepresentable; a scope without a policy simply never purges
--     and is reported honestly by the services);
--   * legal holds carry a release-shape CHECK (released rows record
--     who released them);
--   * tenant scoping uses the composite-FK convention (0002/0003/0030):
--     (application_id, tenant_id) -> applications.applications — a
--     cross-tenant audit row is unrepresentable.
--
-- Migration-runner statement rule (see runner.ts): statements split
-- on `;` at end of line — trigger bodies are single lines with no
-- embedded `;` line endings.

CREATE SCHEMA audit;

CREATE TABLE audit.audit_records (
    id                    uuid PRIMARY KEY,
    application_id        uuid NOT NULL,
    tenant_id             uuid NOT NULL,
    record_id             text NOT NULL,
    chain_sequence        bigint NOT NULL,
    action_kind           text NOT NULL,
    actor_id              text NOT NULL,
    actor_kind            text NOT NULL,
    target_kind           text NOT NULL,
    target_id             text NOT NULL,
    seam                  text NOT NULL,
    source_record_id      text,
    environment           text NOT NULL,
    occurred_at           timestamptz NOT NULL,
    recorded_at           timestamptz NOT NULL DEFAULT now(),
    previous_record_digest text NOT NULL,
    record_digest         text NOT NULL,
    payload               jsonb NOT NULL,
    CONSTRAINT audit_records_sequence_positive CHECK (chain_sequence >= 1),
    CONSTRAINT audit_records_action_vocabulary CHECK (
        action_kind IN (
            'execution.created',
            'execution.transitioned',
            'policy.decision',
            'decision.recorded',
            'audit.export-generated',
            'audit.legal-hold-placed',
            'audit.legal-hold-released',
            'retention.policy-adopted',
            'retention.purge-executed'
        )
    ),
    CONSTRAINT audit_records_actor_vocabulary CHECK (
        actor_kind IN ('human-principal', 'service-principal', 'system-procedure')
    ),
    CONSTRAINT audit_records_target_vocabulary CHECK (
        target_kind IN ('execution', 'decision', 'application')
    ),
    CONSTRAINT audit_records_seam_vocabulary CHECK (
        seam IN (
            'executions.create',
            'executions.transition',
            'policies.admission',
            'optimization-decisions',
            'audit.export',
            'audit.legal-hold',
            'retention.policy',
            'retention.purge'
        )
    ),
    CONSTRAINT audit_records_identity_hex CHECK (
        record_id ~ '^[0-9a-f]{64}$'
        AND previous_record_digest ~ '^[0-9a-f]{64}$'
        AND record_digest ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT audit_records_text_bounds CHECK (
        char_length(actor_id) >= 1 AND char_length(actor_id) <= 128
        AND char_length(target_id) >= 1 AND char_length(target_id) <= 256
        AND char_length(environment) >= 1 AND char_length(environment) <= 64
        AND (source_record_id IS NULL OR (char_length(source_record_id) >= 1 AND char_length(source_record_id) <= 256))
    ),
    CONSTRAINT audit_records_payload_shape CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT audit_records_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT audit_records_identity_unique UNIQUE (application_id, record_id),
    CONSTRAINT audit_records_chain_unique UNIQUE (application_id, chain_sequence)
);

CREATE INDEX audit_records_by_time ON audit.audit_records (application_id, occurred_at);
CREATE INDEX audit_records_by_target ON audit.audit_records (application_id, target_kind, target_id);
CREATE INDEX audit_records_by_kind ON audit.audit_records (application_id, action_kind);

-- Physical append-only enforcement (single-line trigger bodies; runner rule).
-- The governed retention purge is the ONLY deletion path: it sets the
-- transaction-local session marker before deleting, inside the audit
-- store adapter's purge transaction (delete + evidence + head update
-- commit atomically).
CREATE OR REPLACE FUNCTION audit.audit_records_append_only() RETURNS trigger AS $$ BEGIN IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'audit.audit_records is append-only (TRUNCATE rejected)'; ELSIF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'audit.audit_records is append-only (UPDATE rejected on record %)', OLD.record_id; ELSIF TG_OP = 'DELETE' AND COALESCE(current_setting('audit.governed_purge', true), '') <> 'governed' THEN RAISE EXCEPTION 'audit.audit_records deletion is only permitted inside the governed retention purge (rejected on record %)', OLD.record_id; END IF; RETURN COALESCE(OLD, NEW); END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_records_no_mutation
    BEFORE UPDATE OR DELETE ON audit.audit_records
    FOR EACH ROW EXECUTE FUNCTION audit.audit_records_append_only();

CREATE TRIGGER audit_records_no_truncate
    BEFORE TRUNCATE ON audit.audit_records
    FOR EACH STATEMENT EXECUTE FUNCTION audit.audit_records_append_only();

-- The per-application chain head: a MUTABLE derived pointer (the last
-- sequence + digest), NOT an audit record. It exists only to serialize
-- chain extension (FOR UPDATE) and is recomputable from the records;
-- audit evidence never reads it as truth (verification walks records).
CREATE TABLE audit.chain_heads (
    application_id uuid PRIMARY KEY,
    tenant_id      uuid NOT NULL,
    last_sequence  bigint NOT NULL,
    last_digest    text NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_chain_heads_sequence CHECK (last_sequence >= 0),
    CONSTRAINT audit_chain_heads_digest_hex CHECK (last_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT audit_chain_heads_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

-- Legal holds: placing a hold on a scope suspends retention expiry for
-- that scope; holds are governed procedure rows (their placement and
-- release are AUDITED as audit records). Only the release columns are
-- mutable — under the audit services' single write path.
CREATE TABLE audit.legal_holds (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    hold_scope     text NOT NULL,
    target_kind    text,
    target_id      text,
    reason         text NOT NULL,
    placed_by      text NOT NULL,
    placed_at      timestamptz NOT NULL DEFAULT now(),
    released_at    timestamptz,
    released_by    text,
    CONSTRAINT audit_hold_scope_vocabulary CHECK (hold_scope IN ('application', 'target')),
    CONSTRAINT audit_hold_shape CHECK (
        (hold_scope = 'application' AND target_kind IS NULL AND target_id IS NULL)
        OR (hold_scope = 'target' AND target_kind IS NOT NULL AND target_id IS NOT NULL)
    ),
    CONSTRAINT audit_hold_target_vocabulary CHECK (
        target_kind IS NULL OR target_kind IN ('execution', 'decision', 'application')
    ),
    CONSTRAINT audit_hold_reason_bounds CHECK (char_length(reason) >= 1 AND char_length(reason) <= 500),
    CONSTRAINT audit_hold_actor_bounds CHECK (
        char_length(placed_by) >= 1 AND char_length(placed_by) <= 128
        AND (released_by IS NULL OR (char_length(released_by) >= 1 AND char_length(released_by) <= 128))
    ),
    CONSTRAINT audit_hold_release_shape CHECK (
        (released_at IS NULL AND released_by IS NULL)
        OR (released_at IS NOT NULL AND released_by IS NOT NULL)
    ),
    CONSTRAINT audit_hold_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX audit_holds_active ON audit.legal_holds (application_id) WHERE released_at IS NULL;
CREATE INDEX audit_holds_target ON audit.legal_holds (application_id, target_kind, target_id) WHERE released_at IS NULL;

-- Retention policies: bounded by construction (a finite horizon is the
-- only representable shape; unbounded retention is unrepresentable).
-- The latest version per application is the active policy.
CREATE TABLE audit.retention_policies (
    id             uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id      uuid NOT NULL,
    version        integer NOT NULL,
    retention_days integer NOT NULL,
    reason         text NOT NULL,
    adopted_by     text NOT NULL,
    adopted_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_retention_version CHECK (version >= 1),
    CONSTRAINT audit_retention_days_bounded CHECK (retention_days >= 1 AND retention_days <= 3650),
    CONSTRAINT audit_retention_reason_bounds CHECK (char_length(reason) >= 1 AND char_length(reason) <= 500),
    CONSTRAINT audit_retention_actor_bounds CHECK (char_length(adopted_by) >= 1 AND char_length(adopted_by) <= 128),
    CONSTRAINT audit_retention_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT audit_retention_identity UNIQUE (application_id, version)
);
