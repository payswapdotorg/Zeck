-- WORK-002 — Identity, applications and tenant isolation.
--
-- Durable schema for actors, tenants, applications, environments, memberships
-- and the idempotency ledger (`spec/contracts.md` "Idempotency response rule",
-- `IMPLEMENTATION.md` §4).
--
-- Tenant-isolation invariants encoded here (acceptance criterion 2):
--   * every ownership-bearing row carries an explicit `tenant_id`;
--   * `applications (id, tenant_id)` is UNIQUE, so an application id can pair
--     with exactly one tenant — no cross-tenant ownership ambiguity;
--   * `memberships` and `environments` reference applications through the
--     COMPOSITE key (application_id, tenant_id): a row whose tenant_id
--     disagrees with the owning application's tenant cannot exist;
--   * tenant-level authority is a membership with `application_id IS NULL`
--     (CHECK-enforced), never a separate authority table.

CREATE SCHEMA IF NOT EXISTS applications;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS platform;

-- ---------------------------------------------------------------------------
-- Tenants (owned by the applications module).
-- ---------------------------------------------------------------------------

CREATE TABLE applications.tenants (
    id          uuid PRIMARY KEY,
    slug        text NOT NULL,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
    CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

-- ---------------------------------------------------------------------------
-- Applications (owned by the applications module).
-- ---------------------------------------------------------------------------

CREATE TABLE applications.applications (
    id          uuid PRIMARY KEY,
    tenant_id   uuid NOT NULL REFERENCES applications.tenants (id),
    slug        text NOT NULL,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT applications_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
    CONSTRAINT applications_slug_unique_per_tenant UNIQUE (tenant_id, slug),
    -- Anti-ambiguity key: exactly one tenant may own a given application id.
    CONSTRAINT applications_id_tenant_unique UNIQUE (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Environments (owned by the applications module).
-- ---------------------------------------------------------------------------

CREATE TABLE applications.environments (
    id              uuid PRIMARY KEY,
    application_id  uuid NOT NULL,
    tenant_id       uuid NOT NULL,
    kind            text NOT NULL,
    name            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT environments_kind CHECK (kind IN ('development', 'staging', 'production')),
    CONSTRAINT environments_name_format CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
    CONSTRAINT environments_unique_per_application UNIQUE (application_id, name),
    -- Composite reference: tenant_id must equal the owning application's tenant.
    CONSTRAINT environments_application_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Actors (owned by the auth module). Authentication material arrives with the
-- Work Order that owns credential transport; identity rows are the durable
-- actor records.
-- ---------------------------------------------------------------------------

CREATE TABLE identity.actors (
    id               uuid PRIMARY KEY,
    external_subject text,
    display_name     text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT actors_external_subject_unique UNIQUE (external_subject)
);

-- ---------------------------------------------------------------------------
-- Memberships (owned by the auth module).
--
-- A membership authorizes an actor either
--   * application-scoped:  role IN ('owner','admin','member') AND
--                          application_id IS NOT NULL, or
--   * tenant-scoped:       role = 'owner' AND application_id IS NULL
--                          (tenant-level authority, e.g. creating the first
--                          application inside a tenant).
-- ---------------------------------------------------------------------------

CREATE TABLE identity.memberships (
    id              uuid PRIMARY KEY,
    actor_id        uuid NOT NULL REFERENCES identity.actors (id),
    application_id  uuid REFERENCES applications.applications (id),
    tenant_id       uuid NOT NULL REFERENCES applications.tenants (id),
    role            text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memberships_role CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT memberships_scope_shape CHECK (
        (application_id IS NULL AND role = 'owner')
        OR (application_id IS NOT NULL AND role IN ('owner', 'admin', 'member'))
    ),
    CONSTRAINT memberships_actor_application_unique UNIQUE (actor_id, application_id),
    -- Anti-ambiguity: a membership's tenant must be the application's tenant.
    CONSTRAINT memberships_application_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

-- Tenant-level memberships are one-per-actor-per-tenant.
CREATE UNIQUE INDEX memberships_actor_tenant_unique
    ON identity.memberships (actor_id, tenant_id)
    WHERE application_id IS NULL;

-- Ownership lookups are tenant-scoped by construction.
CREATE INDEX memberships_by_application
    ON identity.memberships (application_id, tenant_id)
    WHERE application_id IS NOT NULL;

CREATE INDEX memberships_by_actor
    ON identity.memberships (actor_id, tenant_id);

-- ---------------------------------------------------------------------------
-- Idempotency ledger (platform-owned durable arbitration).
--
-- Insertion, the guarded operation and the durable outcome commit in ONE
-- transaction, so a row exists iff its outcome exists (crash-safe).
--
-- Arbitration keys (`spec/contracts.md` "Idempotency response rule"):
--   * application-scoped operations: (application_id, operation_name,
--     idempotency_key) — actor-independent, exactly the contract scope;
--   * pre-application operations (create tenant/application): (actor_id,
--     operation_name, idempotency_key) — the caller is the only stable scope.
--
-- Same key + same fingerprint replays the recorded outcome; same key +
-- different fingerprint is rejected as IDEMPOTENCY_KEY_REUSED. Concurrent
-- identical requests converge to one durable identity via the unique indexes
-- and transactional arbitration.
-- ---------------------------------------------------------------------------

CREATE TABLE platform.idempotency_records (
    id                  uuid PRIMARY KEY,
    actor_id            uuid NOT NULL,
    application_id      uuid,
    operation_name      text NOT NULL,
    idempotency_key     text NOT NULL,
    request_fingerprint text NOT NULL,
    durable_outcome     jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT idempotency_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    CONSTRAINT idempotency_operation_nonempty CHECK (length(operation_name) BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX idempotency_application_scope_unique
    ON platform.idempotency_records (application_id, operation_name, idempotency_key)
    WHERE application_id IS NOT NULL;

CREATE UNIQUE INDEX idempotency_actor_scope_unique
    ON platform.idempotency_records (actor_id, operation_name, idempotency_key)
    WHERE application_id IS NULL;
