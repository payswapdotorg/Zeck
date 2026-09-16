-- DEP-011 — Application transport credentials (auth module).
--
-- Durable schema for the credential lifecycle: application-scoped transport
-- credential records whose secret material lives ONLY as opaque
-- `zeck-secret://<environment>/<name>` references in the platform secret
-- store (never in the record, never in a wire shape, never in a log line).
--
-- Lineage invariants encoded here:
--   * a credential identity (`credential_id`) is stable across rotations;
--   * AT MOST ONE record per identity may be ACTIVE at any time (the
--     partial unique index below);
--   * rotation retires the predecessor (status 'retired', rotated_at set,
--     superseded_by naming the successor) and appends the successor;
--   * revocation is the terminal 'revoked' status (idempotent by
--     convergence);
--   * the tenant composite reference keeps a credential row bound to its
--     owning application's tenant (the same anti-ambiguity key as
--     memberships and environments).

CREATE TABLE identity.application_credentials (
    id               uuid PRIMARY KEY,
    credential_id    uuid NOT NULL,
    application_id   uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    label            text NOT NULL,
    role             text NOT NULL,
    status           text NOT NULL,
    secret_reference text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    rotated_at       timestamptz,
    superseded_by    uuid,
    CONSTRAINT application_credentials_role CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT application_credentials_status CHECK (status IN ('active', 'retired', 'revoked')),
    CONSTRAINT application_credentials_label_format
        CHECK (label ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'),
    CONSTRAINT application_credentials_secret_reference_shape
        CHECK (secret_reference ~ '^zeck-secret://[a-z]+/[a-z0-9-]+$'),
    CONSTRAINT application_credentials_lineage_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

-- One ACTIVE record per credential identity (the rotation serialization point).
CREATE UNIQUE INDEX application_credentials_active_unique
    ON identity.application_credentials (credential_id)
    WHERE status = 'active';

-- Application listings are scope-checked reads.
CREATE INDEX application_credentials_by_application
    ON identity.application_credentials (application_id, tenant_id);

-- Lineage traversal (predecessor -> successor).
CREATE INDEX application_credentials_by_identity
    ON identity.application_credentials (credential_id, created_at);
