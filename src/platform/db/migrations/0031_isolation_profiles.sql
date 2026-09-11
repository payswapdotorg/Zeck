-- WORK-058 — Compute isolation classes and runtime tenant isolation
-- (D-08; SEC-001 + SEC-002).
--
-- The durable isolation plane layered ON the existing sandbox and
-- compute-plane authorities — never a new authority, never a second
-- state machine:
--
--   * sandbox.compute_environments gains the ISOLATION-PROFILE
--     projection columns (`isolation_class`, `pool_id`). The SPEC
--     (jsonb) remains the single source of truth: the columns are the
--     indexed, physically-constrained projection the compute-plane
--     gates read. A consistency trigger makes any disagreement between
--     the spec's isolation declaration and the columns UNREPRESENTABLE
--     — an ambient default profile assignment (columns claiming a
--     class the spec never declared) is physically rejected.
--
--   * compute_plane.worker_registrations gains the typed POOL BINDING
--     (`pool_id`): the dedicated runner pool a customer-runner worker
--     serves. First-party workers carry no pool (the platform's shared
--     pool is the un-dedicated default posture; a first-party worker
--     with a pool is unrepresentable). The binding is immutable after
--     registration (a worker never changes pools mid-identity —
--     restart registers a new identity, as before).
--
--   * compute_plane.worker_claims gains the POOL OF THE CLAIMED WORK
--     (`pool_id`), derived at admission from the compute environment's
--     declaration INSIDE the admission transaction (scoped resolution
--     at the seam — the caller never passes a free-form pool).
--
--   * THE PHYSICAL TENANT-ISOLATION + POOL GATE (SEC-001/SEC-002,
--     by construction): a BEFORE INSERT trigger on worker_claims
--     enforcing, for EVERY claim admission including evacuation and
--     reassignment (a successor claim is a fresh INSERT through the
--     same gate):
--       - the claim's tenant IS the execution's tenant (read from the
--         executions authority — a misrouted/hostile claim whose
--         tenant disagrees fails closed);
--       - the claim's tenant IS the compute environment's tenant
--         (the work's resource namespace);
--       - a dedicated-customer environment admits claims ONLY from
--         workers bound to ITS pool (pool cross-talk is physically
--         unrepresentable — no claim of pool B may reference an
--         environment of pool A).
--
-- Migration-version discipline (the collision rule): the live
-- inventory at authoring time is 0001..0014, 0016..0030 (0015 is
-- BURNED). **WORK-058 claims 0031 — THIS migration. A collision with a
-- merged sibling is reconciled by the Architect at merge time.**
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — every trigger function body below is a
-- single line with no embedded `;` line endings.

-- ---------------------------------------------------------------------------
-- Sandbox compute environments: the isolation-profile projection.
-- ---------------------------------------------------------------------------

ALTER TABLE sandbox.compute_environments
    ADD COLUMN isolation_class text NOT NULL DEFAULT 'standard',
    ADD COLUMN pool_id text;

ALTER TABLE sandbox.compute_environments
    ADD CONSTRAINT compute_environments_isolation_vocabulary
        CHECK (isolation_class IN ('standard', 'strict', 'dedicated-customer')),
    ADD CONSTRAINT compute_environments_pool_shape
        CHECK ((isolation_class = 'dedicated-customer' AND pool_id IS NOT NULL)
               OR (isolation_class <> 'dedicated-customer' AND pool_id IS NULL)),
    ADD CONSTRAINT compute_environments_pool_shape_bounded
        CHECK (pool_id IS NULL OR (pool_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'));

-- The spec is the single source of the isolation declaration; the
-- columns are its projection. Any disagreement — including a column
-- claiming a class the spec never declared (the ambient-default
-- assignment) or a spec declaring a class the columns dropped (the
-- downgrade) — is physically rejected on INSERT and UPDATE.
CREATE OR REPLACE FUNCTION sandbox.compute_environments_isolation_consistency() RETURNS trigger AS $$ BEGIN IF NEW.isolation_class <> coalesce(NEW.spec -> 'isolation' ->> 'class', 'standard') THEN RAISE EXCEPTION 'compute environment % isolation class "%" disagrees with the spec declaration "%" (the spec is the single source; ambient assignment is unrepresentable)', NEW.id, NEW.isolation_class, coalesce(NEW.spec -> 'isolation' ->> 'class', 'standard'); END IF; IF coalesce(NEW.spec -> 'isolation' ->> 'poolId', '') <> coalesce(NEW.pool_id, '') THEN RAISE EXCEPTION 'compute environment % pool identity disagrees with the spec declaration (the spec is the single source)', NEW.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER compute_environments_isolation_consistency_guard
    BEFORE INSERT OR UPDATE ON sandbox.compute_environments
    FOR EACH ROW EXECUTE FUNCTION sandbox.compute_environments_isolation_consistency();

-- The isolation projection is immutable (with the rest of the
-- specification — profile transitions are governed re-registrations,
-- never in-place downgrades).
CREATE OR REPLACE FUNCTION sandbox.compute_environments_isolation_immutable() RETURNS trigger AS $$ BEGIN IF NEW.isolation_class <> OLD.isolation_class OR NEW.pool_id IS DISTINCT FROM OLD.pool_id THEN RAISE EXCEPTION 'sandbox.compute_environments isolation profile is immutable (environment %); register a new environment instead', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER compute_environments_isolation_immutable_guard
    BEFORE UPDATE ON sandbox.compute_environments
    FOR EACH ROW EXECUTE FUNCTION sandbox.compute_environments_isolation_immutable();

-- ---------------------------------------------------------------------------
-- Worker registrations: the typed pool binding (runner profile wiring).
-- ---------------------------------------------------------------------------

ALTER TABLE compute_plane.worker_registrations
    ADD COLUMN pool_id text;

ALTER TABLE compute_plane.worker_registrations
    ADD CONSTRAINT worker_pool_shape
        CHECK ((kind = 'first-party' AND pool_id IS NULL)
               OR (kind = 'customer-runner' AND (pool_id IS NULL OR pool_id ~ '^[a-z0-9][a-z0-9-]{0,63}$')));

-- The pool binding is part of the registration identity core: a worker
-- never changes pools (a restarted process registers a NEW identity).
CREATE OR REPLACE FUNCTION compute_plane.guard_worker_pool_binding() RETURNS trigger AS $$ BEGIN IF NEW.pool_id IS DISTINCT FROM OLD.pool_id THEN RAISE EXCEPTION 'compute_plane.worker_registrations pool binding is immutable (worker %); a restarted process registers a NEW identity', OLD.worker_id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_registrations_pool_binding_guard
    BEFORE UPDATE ON compute_plane.worker_registrations
    FOR EACH ROW EXECUTE FUNCTION compute_plane.guard_worker_pool_binding();

-- ---------------------------------------------------------------------------
-- Worker claims: the pool of the claimed work + the physical gates.
-- ---------------------------------------------------------------------------

ALTER TABLE compute_plane.worker_claims
    ADD COLUMN pool_id text;

ALTER TABLE compute_plane.worker_claims
    ADD CONSTRAINT claim_pool_shape_bounded
        CHECK (pool_id IS NULL OR (pool_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'));

-- The claim's pool is part of its identity core (immutable, like the
-- environment/worker binding): the pool of the claimed work never
-- changes under a live claim.
CREATE OR REPLACE FUNCTION compute_plane.guard_worker_claim_pool() RETURNS trigger AS $$ BEGIN IF NEW.pool_id IS DISTINCT FROM OLD.pool_id THEN RAISE EXCEPTION 'compute_plane.worker_claims pool identity is immutable (claim %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_claims_pool_guard
    BEFORE UPDATE ON compute_plane.worker_claims
    FOR EACH ROW EXECUTE FUNCTION compute_plane.guard_worker_claim_pool();

-- THE PHYSICAL TENANT-ISOLATION + POOL GATE: every claim admission
-- (fresh delivery, recovery re-selection, evacuation successor) passes
-- here. Cross-tenant claims and pool cross-talk are unrepresentable.
CREATE OR REPLACE FUNCTION compute_plane.claim_tenant_isolation_gate() RETURNS trigger AS $$ DECLARE exec_tenant uuid; env_tenant uuid; env_class text; env_pool text; worker_pool text; BEGIN SELECT tenant_id INTO exec_tenant FROM executions.executions WHERE id = NEW.execution_id AND application_id = NEW.application_id; IF exec_tenant IS NULL THEN RAISE EXCEPTION 'claim tenant isolation gate: execution % does not exist in application %', NEW.execution_id, NEW.application_id; END IF; IF exec_tenant <> NEW.tenant_id THEN RAISE EXCEPTION 'claim tenant isolation gate: claim of execution % carries tenant % but the execution belongs to tenant % (misrouted claims fail closed)', NEW.execution_id, NEW.tenant_id, exec_tenant; END IF; SELECT tenant_id, isolation_class, pool_id INTO env_tenant, env_class, env_pool FROM sandbox.compute_environments WHERE id = NEW.compute_environment_id AND application_id = NEW.application_id; IF env_tenant IS NULL THEN RAISE EXCEPTION 'claim tenant isolation gate: compute environment % does not exist in application %', NEW.compute_environment_id, NEW.application_id; END IF; IF env_tenant <> NEW.tenant_id THEN RAISE EXCEPTION 'claim tenant isolation gate: compute environment % belongs to tenant % but the claim carries tenant % (cross-tenant resource access fails closed)', NEW.compute_environment_id, env_tenant, NEW.tenant_id; END IF; SELECT w.pool_id INTO worker_pool FROM compute_plane.worker_registrations w WHERE w.worker_id = NEW.worker_id; IF env_class = 'dedicated-customer' THEN IF worker_pool IS NULL OR worker_pool <> env_pool THEN RAISE EXCEPTION 'claim tenant isolation gate: dedicated-customer environment % (pool %) admits no claim from worker % (pool %); dedicated pools share nothing', NEW.compute_environment_id, env_pool, NEW.worker_id, coalesce(worker_pool, 'unbound'); END IF; NEW.pool_id := env_pool; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER worker_claims_tenant_isolation_gate
    BEFORE INSERT ON compute_plane.worker_claims
    FOR EACH ROW EXECUTE FUNCTION compute_plane.claim_tenant_isolation_gate();
