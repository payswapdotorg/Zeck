-- WORK-003 — Connections, BYOK and provider federation.
--
-- Durable schema for provider-neutral connections, the encrypted BYOK
-- credential vault and the provider dispatch journal
-- (`spec/requirements.md` CON-001..CON-005, `IMPLEMENTATION.md` §9–§10).
--
-- Invariants encoded here:
--   * every ownership-bearing row carries an explicit `tenant_id`, and
--     connections reference applications through the COMPOSITE key
--     (application_id, tenant_id) — a cross-tenant connection row is
--     unrepresentable (WORK-002 anti-ambiguity pattern);
--   * the credential vault stores ciphertext bytes ONLY (envelope format
--     `aes-256-gcm-v1`); plaintext has no durable representation anywhere;
--   * a connection's credential shape is CHECK-constrained: byok requires a
--     vault reference, platform forbids one;
--   * the dispatch journal's outcome payload is CHECK-constrained to the
--     PROVIDER axis ('provider-success' | 'provider-failure') — quality/
--     verification outcome classes are physically unrepresentable on this
--     axis (CON-005 durable proof);
--   * dispatch intent rows exist before outcomes (durable-then-observe).

CREATE SCHEMA IF NOT EXISTS connections;
CREATE SCHEMA IF NOT EXISTS models;

-- ---------------------------------------------------------------------------
-- BYOK credential vault (owned by the connections module).
--
-- One row per stored materialization; rotation writes a new reference and
-- destroys the superseded row in the same transaction. The envelope cipher
-- binds each ciphertext to its reference (AAD), so ciphertext cannot be
-- transplanted between rows.
-- ---------------------------------------------------------------------------

CREATE TABLE connections.credentials (
    reference       uuid PRIMARY KEY,
    classification  text NOT NULL DEFAULT 'provider-credential',
    cipher          text NOT NULL,
    ciphertext      bytea NOT NULL,
    description     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credentials_classification CHECK (classification IN ('provider-credential')),
    CONSTRAINT credentials_cipher CHECK (cipher = 'aes-256-gcm-v1'),
    CONSTRAINT credentials_ciphertext_nonempty CHECK (octet_length(ciphertext) >= 29)
);

-- ---------------------------------------------------------------------------
-- Connections (owned by the connections module).
--
-- Provider-neutral registration of a supply path: an aggregation rail, a
-- direct provider, or a customer endpoint. The rail is a slug from the
-- module vocabulary — never a provider SDK type.
-- ---------------------------------------------------------------------------

CREATE TABLE connections.connections (
    id              uuid PRIMARY KEY,
    application_id  uuid NOT NULL,
    tenant_id       uuid NOT NULL,
    rail            text NOT NULL,
    label           text NOT NULL,
    endpoint_url    text,
    credential_kind text NOT NULL,
    credential_ref  uuid,
    status          text NOT NULL DEFAULT 'active',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connections_rail CHECK (rail IN ('openrouter', 'anthropic', 'custom')),
    CONSTRAINT connections_label_format CHECK (label ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
    CONSTRAINT connections_status CHECK (status IN ('active', 'disabled')),
    CONSTRAINT connections_credential_shape CHECK (
        (credential_kind = 'byok' AND credential_ref IS NOT NULL)
        OR (credential_kind = 'platform' AND credential_ref IS NULL)
    ),
    CONSTRAINT connections_credential_fk
        FOREIGN KEY (credential_ref) REFERENCES connections.credentials (reference),
    -- Anti-ambiguity: a connection's tenant must be its application's tenant.
    CONSTRAINT connections_application_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT connections_label_unique UNIQUE (application_id, tenant_id, label)
);

CREATE INDEX connections_by_application
    ON connections.connections (application_id, tenant_id);

-- ---------------------------------------------------------------------------
-- Provider dispatch journal (owned by the models module).
--
-- Durable intent + observed outcome for every dispatch attempt
-- (`IMPLEMENTATION.md` §14 sequence). Evidence, not authority: nothing here
-- can drive execution state (/executions owns that) — but the provider-axis
-- outcome classes are physically exclusive of the quality/verification axis.
--
-- Outcome payload classes:
--   * provider-success / provider-failure — the ONLY classes the provider
--     axis may carry (CHECK-enforced);
--   * {denied: true, reason} — admission denial evidence (admitted=false),
--     produced by the policy gate before any dispatch.
--
-- A quality or verification outcome class (e.g. 'verification-failed') is
-- UNREPRESENTABLE in outcome->>'outcomeClass' by the CHECK below — that is
-- the durable distinction CON-005 requires.
-- ---------------------------------------------------------------------------

-- connection_id is lineage BY VALUE: dispatch evidence must survive the
-- lifecycle of the connection row (removal never rewrites history); the
-- gateway guarantees tenant consistency at write time.

CREATE TABLE models.dispatch_attempts (
    id              uuid PRIMARY KEY,
    tenant_id       uuid NOT NULL,
    application_id  uuid NOT NULL,
    connection_id   uuid NOT NULL,
    rail            text NOT NULL,
    model           text NOT NULL,
    request_hash    text NOT NULL,
    admitted        boolean NOT NULL,
    status          text NOT NULL,
    outcome         jsonb,
    denial_reason   text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    CONSTRAINT dispatch_status CHECK (
        status IN ('dispatching', 'succeeded', 'provider-failed', 'denied')
    ),
    CONSTRAINT dispatch_shape CHECK (
        (status = 'denied' AND admitted = FALSE AND outcome IS NOT NULL)
        OR (status <> 'denied' AND admitted = TRUE)
    ),
    -- CON-005 durable proof: the provider axis carries provider classes only.
    CONSTRAINT dispatch_outcome_provider_axis CHECK (
        outcome IS NULL
        OR (outcome->>'denied') = 'true'
        OR (outcome->>'outcomeClass') IN ('provider-success', 'provider-failure')
    ),
    CONSTRAINT dispatch_status_outcome_agreement CHECK (
        (status IN ('succeeded') AND outcome->>'outcomeClass' = 'provider-success')
        OR (status IN ('provider-failed') AND outcome->>'outcomeClass' = 'provider-failure')
        OR (status IN ('dispatching', 'denied'))
    )
);

CREATE INDEX dispatch_attempts_by_connection
    ON models.dispatch_attempts (connection_id, created_at);

CREATE INDEX dispatch_attempts_by_application
    ON models.dispatch_attempts (application_id, tenant_id);
