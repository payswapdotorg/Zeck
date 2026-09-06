-- WORK-046 — Execution worker deployment fabric (D-05).
--
-- The durable PostgreSQL worker-plane coordination records for the
-- execution-worker fabric (`docs/DEPLOYMENT-ARCHITECTURE.md` §6
-- execution plane, `spec/work-orders/WORK-046.md`).
--
-- WHAT THIS SCHEMA IS:
--
--   * WORKER-PLANE COORDINATION STATE ONLY. It never stores execution
--     status: the authoritative execution lifecycle remains in
--     executions.executions behind its single write path, and the
--     single lease system remains executions.execution_leases (the
--     epoch/owner fencing domain of WORK-028). This migration stores
--     worker registrations, worker CLAIMS (the runtime-correlation
--     rows that bind worker identity <-> execution identity <->
--     compute environment <-> lease epoch), per-environment quotas
--     and the OPTIONAL governed customer-runner registration
--     metadata.
--
--   * The state vocabularies here are DISJOINT from the 14 frozen
--     execution states (case-insensitively — the D-03/D-04 lesson):
--     registration statuses active/draining/offline, claim statuses
--     claimed/finished/abandoned, claim outcomes and abandon causes
--     are coordination/attribution/recovery bookkeeping. There is NO
--     second execution state machine anywhere in this schema and NO
--     mapping between the two vocabularies.
--
--   * A worker is an EXECUTOR, never an execution authority: nothing
--     in this schema can express an execution outcome. The claim's
--     `outcome` column records what the WORKER PLANE did with its
--     claim (applied/converged/not-executable) — the authoritative
--     execution outcome lives only in executions.executions, written
--     only through the frozen transition service.
--
-- Physical invariants (unrepresentable violations, house discipline):
--
--   * worker_registrations: `offline` is terminal-immutable (a worker
--     identity is never resurrected — a restarted process registers a
--     NEW identity); registration status transitions follow
--     active->draining|offline, draining->offline; the heartbeat
--     ledger never regresses; a customer-runner worker must reference
--     a governed runner row of the SAME application in active
--     status; rows are never deleted;
--   * runner_registrations: the governed customer-runner contract —
--     endpoint/secret-reference identity is immutable after
--     registration, `revoked` is terminal-immutable, the lifecycle
--     follows pending->active|revoked, active->suspended|revoked,
--     suspended->active|revoked; rows are never deleted (revocation
--     is the lifecycle end, never deletion);
--   * environment_quotas: one row per compute environment, bounded
--     [1,512]; rows never deleted (quota values are operator state);
--   * worker_claims: ONE LIVE CLAIM per execution physically (partial
--     unique index on execution_id WHERE status='claimed'); the
--     claim-epoch is unique per execution (a claim is exactly the Nth
--     claim of its execution — the bounded re-selection budget is
--     countable in one query); terminal states (finished/abandoned)
--     are PHYSICALLY immutable; the identity core is immutable; the
--     heartbeat ledger never regresses; the lease correlation
--     (owner/epoch) is set EXACTLY once and never rewritten;
--     outcome/abandon fields are shape-bound to their terminal
--     state; deletes are rejected for live rows and allowed only for
--     terminal rows (the bounded claimRetentionMs compaction path
--     removes terminal claims of terminal executions); a claim may
--     only be admitted for a NON-TERMINAL execution; a
--     customer-runner worker may only claim executions of ITS OWN
--     application.
--
-- Migration-version discipline (the collision rule): the live
-- inventory at authoring time is 0001..0014, 0016..0027 (0015 is
-- BURNED). **WORK-046 claims 0028 — THIS migration. No other unmerged
-- Work Order claims 0028.**
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — every trigger function body below is a
-- single line with no embedded `;` line endings.

CREATE SCHEMA compute_plane;

-- ---------------------------------------------------------------------------
-- Customer-runner registrations (the OPTIONAL governed executor
-- metadata — attributable, revocable, NON-AUTHORITATIVE).
-- ---------------------------------------------------------------------------

CREATE TABLE compute_plane.runner_registrations (
    runner_id          uuid PRIMARY KEY,
    application_id     uuid NOT NULL,
    tenant_id          uuid NOT NULL,
    endpoint_url       text NOT NULL,
    token_secret_ref   text NOT NULL,
    status             text NOT NULL DEFAULT 'pending',
    registered_by      text NOT NULL,
    registered_at      timestamptz NOT NULL,
    activated_at       timestamptz,
    suspended_at       timestamptz,
    revoked_at         timestamptz,
    revocation_reason  text,
    metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT runner_status_vocabulary
        CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
    CONSTRAINT runner_endpoint_shape
        CHECK (endpoint_url ~ '^https?://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(/.*)?$'
               AND length(endpoint_url) <= 512),
    CONSTRAINT runner_token_ref_shape
        CHECK (token_secret_ref ~ '^zeck-secret://[a-z0-9-]+/[a-z0-9-]+$'
               AND length(token_secret_ref) <= 256),
    CONSTRAINT runner_registered_by_nonempty CHECK (length(registered_by) BETWEEN 1 AND 200),
    CONSTRAINT runner_revocation_reason_bounded
        CHECK (revocation_reason IS NULL OR length(revocation_reason) <= 200),
    CONSTRAINT runner_metadata_bounded CHECK (length(metadata::text) <= 2048),
    CONSTRAINT runner_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX runners_by_application ON compute_plane.runner_registrations (application_id, status);

-- The terminal lifecycle shape: revoked runners carry their revocation
-- timestamp; non-terminal states never carry the revocation marker. The
-- suspension timestamp is first-suspension history (set when the runner
-- is first suspended, retained across re-activation).
ALTER TABLE compute_plane.runner_registrations
    ADD CONSTRAINT runner_lifecycle_shape
    CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL)
        OR (status <> 'revoked' AND revoked_at IS NULL)
    );

-- The governed lifecycle transitions + registration identity
-- immutability (pending->active|revoked, active->suspended|revoked,
-- suspended->active|revoked).
CREATE OR REPLACE FUNCTION compute_plane.guard_runner_lifecycle() RETURNS trigger AS $$ BEGIN IF NEW.runner_id <> OLD.runner_id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.endpoint_url <> OLD.endpoint_url OR NEW.token_secret_ref <> OLD.token_secret_ref OR NEW.registered_by <> OLD.registered_by OR NEW.registered_at <> OLD.registered_at OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN RAISE EXCEPTION 'compute_plane.runner_registrations registration identity is immutable (runner %)', OLD.runner_id; END IF; IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'compute_plane.runner_registrations is terminal-immutable in revoked (runner %)', OLD.runner_id; END IF; IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'revoked')) OR (OLD.status = 'active' AND NEW.status IN ('suspended', 'revoked')) OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'revoked'))) THEN RAISE EXCEPTION 'illegal runner registration transition % -> % (runner %)', OLD.status, NEW.status, OLD.runner_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_registrations_lifecycle_guard
    BEFORE UPDATE ON compute_plane.runner_registrations
    FOR EACH ROW EXECUTE FUNCTION compute_plane.guard_runner_lifecycle();

CREATE OR REPLACE FUNCTION compute_plane.runner_registrations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'compute_plane.runner_registrations rows are never deleted (runner %); revocation is the lifecycle end', OLD.runner_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER runner_registrations_no_delete_guard
    BEFORE DELETE ON compute_plane.runner_registrations
    FOR EACH ROW EXECUTE FUNCTION compute_plane.runner_registrations_no_delete();

-- ---------------------------------------------------------------------------
-- Worker registrations (the executor-instance registry).
-- ---------------------------------------------------------------------------

CREATE TABLE compute_plane.worker_registrations (
    worker_id             uuid PRIMARY KEY,
    application_id        uuid NOT NULL,
    kind                  text NOT NULL,
    runner_id             uuid,
    status                text NOT NULL DEFAULT 'active',
    declared_concurrency  integer NOT NULL,
    heartbeat_count       integer NOT NULL DEFAULT 0,
    registered_at         timestamptz NOT NULL,
    last_heartbeat_at     timestamptz NOT NULL,
    drain_requested_at    timestamptz,
    went_offline_at       timestamptz,
    offline_reason        text,
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT worker_kind_vocabulary CHECK (kind IN ('first-party', 'customer-runner')),
    CONSTRAINT worker_status_vocabulary CHECK (status IN ('active', 'draining', 'offline')),
    CONSTRAINT worker_declared_concurrency_bounded
        CHECK (declared_concurrency BETWEEN 1 AND 128),
    CONSTRAINT worker_heartbeats_nonnegative CHECK (heartbeat_count >= 0),
    CONSTRAINT worker_offline_reason_bounded
        CHECK (offline_reason IS NULL OR length(offline_reason) <= 200),
    CONSTRAINT worker_metadata_bounded CHECK (length(metadata::text) <= 2048),
    CONSTRAINT worker_kind_runner_shape
        CHECK ((kind = 'customer-runner' AND runner_id IS NOT NULL)
               OR (kind = 'first-party' AND runner_id IS NULL)),
    CONSTRAINT worker_offline_shape
        CHECK ((status = 'offline' AND went_offline_at IS NOT NULL)
               OR (status <> 'offline' AND went_offline_at IS NULL AND offline_reason IS NULL)),
    CONSTRAINT worker_drain_shape
        CHECK ((status = 'draining' AND drain_requested_at IS NOT NULL)
               OR (status = 'active' AND drain_requested_at IS NULL)
               OR (status = 'offline')),
    CONSTRAINT worker_application_fk
        FOREIGN KEY (application_id) REFERENCES applications.applications (id),
    CONSTRAINT worker_runner_fk
        FOREIGN KEY (runner_id) REFERENCES compute_plane.runner_registrations (runner_id)
);

CREATE INDEX workers_by_status ON compute_plane.worker_registrations (status, last_heartbeat_at);
CREATE INDEX workers_by_application ON compute_plane.worker_registrations (application_id, status);

-- The registration lifecycle guard: active->draining|offline,
-- draining->offline, offline is terminal-immutable; the identity core
-- (worker/application/runner/kind/concurrency) is immutable; the
-- heartbeat ledger never regresses.
CREATE OR REPLACE FUNCTION compute_plane.guard_worker_registration() RETURNS trigger AS $$ BEGIN IF NEW.worker_id <> OLD.worker_id OR NEW.application_id <> OLD.application_id OR NEW.kind <> OLD.kind OR NEW.runner_id IS DISTINCT FROM OLD.runner_id OR NEW.declared_concurrency <> OLD.declared_concurrency OR NEW.registered_at <> OLD.registered_at OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN RAISE EXCEPTION 'compute_plane.worker_registrations identity core is immutable (worker %)', OLD.worker_id; END IF; IF NEW.heartbeat_count < OLD.heartbeat_count THEN RAISE EXCEPTION 'worker % heartbeat count must not regress (% -> %)', OLD.worker_id, OLD.heartbeat_count, NEW.heartbeat_count; END IF; IF OLD.status = 'offline' THEN RAISE EXCEPTION 'compute_plane.worker_registrations is terminal-immutable in offline (worker %); a restarted process registers a NEW identity', OLD.worker_id; END IF; IF NEW.status = OLD.status THEN RETURN NEW; END IF; IF NOT ((OLD.status = 'active' AND NEW.status IN ('draining', 'offline')) OR (OLD.status = 'draining' AND NEW.status = 'offline')) THEN RAISE EXCEPTION 'illegal worker registration transition % -> % (worker %)', OLD.status, NEW.status, OLD.worker_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_registrations_lifecycle_guard
    BEFORE UPDATE ON compute_plane.worker_registrations
    FOR EACH ROW EXECUTE FUNCTION compute_plane.guard_worker_registration();

-- A customer-runner worker must reference a governed runner row of the
-- SAME application whose status is active (registration of a
-- suspended/revoked/never-activated runner is unrepresentable).
CREATE OR REPLACE FUNCTION compute_plane.worker_runner_governance_gate() RETURNS trigger AS $$ DECLARE runner_status text; runner_app uuid; BEGIN IF NEW.kind = 'first-party' THEN RETURN NEW; END IF; SELECT status, application_id INTO runner_status, runner_app FROM compute_plane.runner_registrations WHERE runner_id = NEW.runner_id; IF runner_status IS NULL THEN RAISE EXCEPTION 'worker % references runner % which does not exist', NEW.worker_id, NEW.runner_id; END IF; IF runner_app <> NEW.application_id THEN RAISE EXCEPTION 'worker % references runner % of a different application', NEW.worker_id, NEW.runner_id; END IF; IF runner_status <> 'active' THEN RAISE EXCEPTION 'worker % references runner % in status %; only active runners may register workers', NEW.worker_id, NEW.runner_id, runner_status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_runner_governance_gate
    BEFORE INSERT OR UPDATE OF runner_id, application_id, kind ON compute_plane.worker_registrations
    FOR EACH ROW EXECUTE FUNCTION compute_plane.worker_runner_governance_gate();

CREATE OR REPLACE FUNCTION compute_plane.worker_registrations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'compute_plane.worker_registrations rows are never deleted (worker %)', OLD.worker_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_registrations_no_delete_guard
    BEFORE DELETE ON compute_plane.worker_registrations
    FOR EACH ROW EXECUTE FUNCTION compute_plane.worker_registrations_no_delete();

-- ---------------------------------------------------------------------------
-- Per-compute-environment quotas (bounded, observable, never a new
-- authority: admission enforcement lives in the claim gate).
-- ---------------------------------------------------------------------------

CREATE TABLE compute_plane.environment_quotas (
    compute_environment_id  uuid PRIMARY KEY,
    application_id          uuid NOT NULL,
    max_concurrent_claims   integer NOT NULL DEFAULT 8,
    updated_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quota_bound CHECK (max_concurrent_claims BETWEEN 1 AND 512),
    CONSTRAINT quota_environment_fk
        FOREIGN KEY (compute_environment_id, application_id)
        REFERENCES sandbox.compute_environments (id, application_id)
);

CREATE OR REPLACE FUNCTION compute_plane.environment_quotas_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'compute_plane.environment_quotas rows are never deleted (environment %)', OLD.compute_environment_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER environment_quotas_no_delete_guard
    BEFORE DELETE ON compute_plane.environment_quotas
    FOR EACH ROW EXECUTE FUNCTION compute_plane.environment_quotas_no_delete();

-- ---------------------------------------------------------------------------
-- Worker claims (the runtime-correlation rows: worker identity <->
-- execution identity <-> compute environment <-> lease epoch).
-- ---------------------------------------------------------------------------

CREATE TABLE compute_plane.worker_claims (
    id                     uuid PRIMARY KEY,
    execution_id           uuid NOT NULL,
    application_id         uuid NOT NULL,
    tenant_id              uuid NOT NULL,
    environment_id         uuid,
    compute_environment_id uuid NOT NULL,
    worker_id              uuid NOT NULL,
    claim_epoch            integer NOT NULL,
    lease_owner            text,
    lease_epoch            integer,
    status                 text NOT NULL DEFAULT 'claimed',
    claimed_at             timestamptz NOT NULL,
    heartbeat_count        integer NOT NULL DEFAULT 0,
    last_heartbeat_at      timestamptz,
    finished_at            timestamptz,
    outcome                text,
    outcome_detail         jsonb,
    abandoned_at           timestamptz,
    abandon_cause          text,
    abandon_detail         jsonb,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT claim_status_vocabulary CHECK (status IN ('claimed', 'finished', 'abandoned')),
    CONSTRAINT claim_epoch_positive CHECK (claim_epoch >= 1),
    CONSTRAINT claim_heartbeats_nonnegative CHECK (heartbeat_count >= 0),
    CONSTRAINT claim_outcome_vocabulary
        CHECK (outcome IN ('applied-success', 'applied-failure', 'converged-elsewhere', 'not-executable')),
    CONSTRAINT claim_outcome_detail_bounded CHECK (length(coalesce(outcome_detail::text, '')) <= 8192),
    CONSTRAINT claim_abandon_detail_bounded CHECK (length(coalesce(abandon_detail::text, '')) <= 2048),
    CONSTRAINT claim_abandon_cause_vocabulary
        CHECK (abandon_cause IN ('lease-conflict', 'lease-elapsed', 'lease-superseded', 'lease-released',
                                 'heartbeat-lost', 'worker-drained', 'worker-lost', 'work-refused',
                                 'stale-write', 'work-retryable')),
    CONSTRAINT claim_terminal_shape
        CHECK (
            (status = 'claimed'
                AND finished_at IS NULL AND abandoned_at IS NULL AND outcome IS NULL
                AND abandon_cause IS NULL AND outcome_detail IS NULL AND abandon_detail IS NULL)
            OR (status = 'finished'
                AND finished_at IS NOT NULL AND outcome IS NOT NULL
                AND abandoned_at IS NULL AND abandon_cause IS NULL AND abandon_detail IS NULL)
            OR (status = 'abandoned'
                AND abandoned_at IS NOT NULL AND abandon_cause IS NOT NULL
                AND finished_at IS NULL AND outcome IS NULL AND outcome_detail IS NULL)
        ),
    CONSTRAINT claim_lease_correlation_shape
        CHECK ((lease_owner IS NULL AND lease_epoch IS NULL) OR (lease_owner IS NOT NULL AND lease_epoch >= 1)),
    CONSTRAINT claim_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT claim_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT claim_compute_environment_fk
        FOREIGN KEY (compute_environment_id, application_id)
        REFERENCES sandbox.compute_environments (id, application_id),
    CONSTRAINT claim_worker_fk
        FOREIGN KEY (worker_id) REFERENCES compute_plane.worker_registrations (worker_id)
);

-- ONE LIVE CLAIM per execution, physically.
CREATE UNIQUE INDEX one_live_claim_per_execution
    ON compute_plane.worker_claims (execution_id)
    WHERE status = 'claimed';

-- A claim is exactly the Nth claim of its execution (the bounded
-- re-selection budget is countable in one query).
CREATE UNIQUE INDEX claim_epoch_unique_per_execution
    ON compute_plane.worker_claims (execution_id, claim_epoch);

CREATE INDEX claims_by_execution ON compute_plane.worker_claims (execution_id, created_at);
CREATE INDEX claims_by_worker ON compute_plane.worker_claims (worker_id, status);
CREATE INDEX claims_by_compute_environment
    ON compute_plane.worker_claims (compute_environment_id)
    WHERE status = 'claimed';
CREATE INDEX claims_stale_scan
    ON compute_plane.worker_claims (last_heartbeat_at)
    WHERE status = 'claimed';
CREATE INDEX claims_compaction_scan
    ON compute_plane.worker_claims (updated_at)
    WHERE status IN ('finished', 'abandoned');

-- Claim guards: the identity core is immutable; the heartbeat ledger
-- never regresses; the lease correlation is set EXACTLY once (NULL ->
-- value legal, value rewrite illegal); terminal states are physically
-- immutable; the lifecycle follows claimed->finished|abandoned.
CREATE OR REPLACE FUNCTION compute_plane.guard_worker_claim() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.execution_id <> OLD.execution_id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.environment_id IS DISTINCT FROM OLD.environment_id OR NEW.compute_environment_id <> OLD.compute_environment_id OR NEW.worker_id <> OLD.worker_id OR NEW.claim_epoch <> OLD.claim_epoch OR NEW.claimed_at <> OLD.claimed_at OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'compute_plane.worker_claims identity core is immutable (claim %)', OLD.id; END IF; IF NEW.heartbeat_count < OLD.heartbeat_count THEN RAISE EXCEPTION 'claim % heartbeat count must not regress (% -> %)', OLD.id, OLD.heartbeat_count, NEW.heartbeat_count; END IF; IF OLD.lease_owner IS NOT NULL AND (NEW.lease_owner <> OLD.lease_owner OR NEW.lease_epoch <> OLD.lease_epoch) THEN RAISE EXCEPTION 'claim % lease correlation is set once and never rewritten (%/%)', OLD.id, OLD.lease_owner, OLD.lease_epoch; END IF; IF OLD.status = 'finished' OR OLD.status = 'abandoned' THEN RAISE EXCEPTION 'compute_plane.worker_claims is terminal-immutable in % (claim %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'claimed' AND NEW.status IN ('finished', 'abandoned')) OR (OLD.status = NEW.status)) THEN RAISE EXCEPTION 'illegal worker claim transition % -> % (claim %)', OLD.status, NEW.status, OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_claims_lifecycle_guard
    BEFORE UPDATE ON compute_plane.worker_claims
    FOR EACH ROW EXECUTE FUNCTION compute_plane.guard_worker_claim();

-- Deletes are rejected for LIVE rows; terminal rows may be removed ONLY
-- by the bounded claimRetentionMs compaction (the store enforces the age
-- and terminal-execution conditions in SQL; this trigger enforces the
-- terminal-state precondition physically).
CREATE OR REPLACE FUNCTION compute_plane.worker_claims_delete_gate() RETURNS trigger AS $$ BEGIN IF OLD.status <> 'finished' AND OLD.status <> 'abandoned' THEN RAISE EXCEPTION 'compute_plane.worker_claims live rows are never deleted (claim % in %)', OLD.id, OLD.status; END IF; RETURN OLD; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_claims_delete_gate
    BEFORE DELETE ON compute_plane.worker_claims
    FOR EACH ROW EXECUTE FUNCTION compute_plane.worker_claims_delete_gate();

-- A claim may only be admitted for a NON-TERMINAL execution (terminal
-- executions have no claimable work) — the authority-side admission
-- gate, physically enforced. A customer-runner worker may only claim
-- executions of ITS OWN application (governed executor scope).
CREATE OR REPLACE FUNCTION compute_plane.claim_admission_gate() RETURNS trigger AS $$ DECLARE terminal boolean; worker_kind text; worker_app uuid; BEGIN SELECT status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED') INTO terminal FROM executions.executions WHERE id = NEW.execution_id AND application_id = NEW.application_id; IF terminal IS NULL THEN RAISE EXCEPTION 'execution % does not exist in application %', NEW.execution_id, NEW.application_id; END IF; IF terminal THEN RAISE EXCEPTION 'execution % is terminal; no worker claim may be admitted', NEW.execution_id; END IF; SELECT kind, application_id INTO worker_kind, worker_app FROM compute_plane.worker_registrations WHERE worker_id = NEW.worker_id; IF worker_kind IS NULL THEN RAISE EXCEPTION 'worker % does not exist', NEW.worker_id; END IF; IF worker_kind = 'customer-runner' AND worker_app <> NEW.application_id THEN RAISE EXCEPTION 'customer-runner worker % may only claim executions of its own application (%)', NEW.worker_id, worker_app; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_claims_admission_gate
    BEFORE INSERT ON compute_plane.worker_claims
    FOR EACH ROW EXECUTE FUNCTION compute_plane.claim_admission_gate();
