-- WORK-018 — Tool synthesis: durable synthesized-program artifacts
-- (tools schema extension) + the sandbox output-evidence column.
--
-- The durable state of governed program synthesis (TOL-004): the
-- EPHEMERAL, CONTENT-ADDRESSED synthesized-program rows — source,
-- build digest, requested contract, declared test cases, per-phase
-- evidence (static validation, runtime tests, rejection), expiry and
-- submission provenance. "Usable" is reachable ONLY through runtime
-- tests whose per-case evidence carries the SANDBOX EXECUTION
-- identities the cases actually ran on — test evidence cannot be
-- fabricated because it is written exactly once by the guarded
-- validated→usable/rejected transition.
--
-- AUTHORITY PRESERVATION (the frozen invariants):
--   * there is NO policy/capability/budget/verification surface in
--     this migration: a synthesized tool is governed by the EXISTING
--     tool runtime admission chain at invocation time (policy →
--     budget → capability) and executed ONLY through the sandbox
--     manager (the sandbox execution rows remain the execution
--     evidence; the per-case evidence REFERENCES them by identity);
--   * synthesized tools are NOT registered here: the tool registry
--     remains the single tool-admission surface;
--   * cross-module references are READ-ONLY bindings:
--     (application_id, tenant_id) -> applications.applications —
--     tenant identity is never dropped.
--
-- Physical invariants (violations are UNREPRESENTABLE, not merely
-- discouraged):
--   * the IDENTITY CORE is WRITE-ONCE: id, application, tenant,
--     toolId, version, language, source, source digest, contract,
--     test cases, expiry, submittedBy, idempotency key, createdAt are
--     immutable on every UPDATE path (trigger);
--   * the lifecycle is the frozen transition table (trigger):
--     draft→{validated,rejected}, validated→{usable,rejected},
--     usable→retired; terminal statuses (rejected/retired) are
--     immutable;
--   * EVIDENCE fields are written by their OWN transition exactly
--     once: static_validation only on →validated, runtime_tests and
--     rejection only on →usable/→rejected, and never on a path that
--     does not change the status (trigger);
--   * submission idempotency: UNIQUE (application_id,
--     idempotency_key); identity arbitration UNIQUE (application_id,
--     tool_id, version) — a synthesized tool identity is single-owner;
--   * rows are NEVER deleted (trigger).
--
-- Migration-version discipline (the collision rule): the live
-- inventory at authoring time is 0001..0010 (all merged on main;
-- 0010 is WORK-017's learning migration). THIS parallel wave
-- dispatches three in-flight Work Orders (architect dispatch:
-- WORK-018 ║ WORK-023 ║ WORK-031); to prevent merge-order collisions
-- the numbers are pre-assigned by dispatch order and documented in
-- every sibling evidence file: WORK-018 claims 0011 (this file),
-- WORK-023 claims 0012, WORK-031 claims 0013. No unmerged Work Order
-- claims any other number.
--
-- The sandbox extension (ALTER) is the additive WORK-018 surface in
-- the sandbox module (a declared change surface of this Work Order):
-- the bounded provider observation OUTPUT becomes durable evidence on
-- the terminal sandbox row (synthesized-program outputs and test
-- comparisons need the actual stdout; terminal rows are already
-- physically immutable, so the output evidence is write-once).

-- ---------------------------------------------------------------------------
-- Synthesized programs (tools-owned durable artifacts).
-- ---------------------------------------------------------------------------

CREATE TABLE tools.synthesized_programs (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    tool_id       text NOT NULL,
    version       text NOT NULL,
    language      text NOT NULL,
    source        text NOT NULL,
    source_digest text NOT NULL,
    contract      jsonb NOT NULL,
    test_cases    jsonb NOT NULL,
    status        text NOT NULL,
    static_validation jsonb,
    runtime_tests jsonb,
    rejection     jsonb,
    expires_at    timestamptz NOT NULL,
    submitted_by  uuid NOT NULL,
    idempotency_key text NOT NULL,
    submission_fingerprint text NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    CONSTRAINT synth_status_vocabulary CHECK (status IN ('draft','validated','usable','rejected','retired')),
    CONSTRAINT synth_language_vocabulary CHECK (language IN ('javascript')),
    CONSTRAINT synth_tool_prefix CHECK (tool_id ~ '^synth-[a-z0-9][a-z0-9-]{0,98}$'),
    CONSTRAINT synth_source_bounded CHECK (length(source) BETWEEN 1 AND 4096),
    CONSTRAINT synth_digest_nonempty CHECK (length(source_digest) BETWEEN 1 AND 128),
    CONSTRAINT synth_contract_object CHECK (jsonb_typeof(contract) = 'object'),
    CONSTRAINT synth_test_cases_array CHECK (jsonb_typeof(test_cases) = 'array'),
    CONSTRAINT synth_test_cases_bounded CHECK (jsonb_array_length(test_cases) BETWEEN 1 AND 16),
    CONSTRAINT synth_fingerprint_nonempty CHECK (length(submission_fingerprint) BETWEEN 1 AND 8192),
    CONSTRAINT synth_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT synth_expires_after_creation CHECK (expires_at > created_at),
    CONSTRAINT synth_submission_key_unique UNIQUE (application_id, idempotency_key),
    CONSTRAINT synth_tool_identity_unique UNIQUE (application_id, tool_id, version),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX synth_programs_scope_listing
    ON tools.synthesized_programs (application_id, tenant_id, created_at DESC);

CREATE INDEX synth_programs_usable
    ON tools.synthesized_programs (application_id, status, expires_at)
    WHERE status = 'usable';

-- The identity core is write-once; evidence rides its own transition.
CREATE OR REPLACE FUNCTION tools.synthesized_programs_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.tool_id <> OLD.tool_id OR NEW.version <> OLD.version OR NEW.language <> OLD.language OR NEW.source <> OLD.source OR NEW.source_digest <> OLD.source_digest OR NEW.contract IS DISTINCT FROM OLD.contract OR NEW.test_cases IS DISTINCT FROM OLD.test_cases OR NEW.expires_at <> OLD.expires_at OR NEW.submitted_by <> OLD.submitted_by OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.submission_fingerprint <> OLD.submission_fingerprint OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'tools.synthesized_programs identity core is immutable (program %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER synthesized_programs_core_guard
    BEFORE UPDATE ON tools.synthesized_programs
    FOR EACH ROW EXECUTE FUNCTION tools.synthesized_programs_core_immutable();

-- The frozen lifecycle + one-write evidence discipline.
CREATE OR REPLACE FUNCTION tools.synthesized_programs_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status = 'rejected' OR OLD.status = 'retired' THEN RAISE EXCEPTION 'tools.synthesized_programs is terminal-immutable in state % (program %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'draft' AND NEW.status IN ('validated','rejected')) OR (OLD.status = 'validated' AND NEW.status IN ('usable','rejected')) OR (OLD.status = 'usable' AND NEW.status IN ('retired','usable'))) THEN RAISE EXCEPTION 'synthesized program % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; IF NEW.status = OLD.status THEN IF OLD.status <> 'usable' THEN RAISE EXCEPTION 'synthesized program % evidence fields are written exactly once, by their own transition (no re-write without a status advance)', OLD.id; END IF; RETURN NEW; END IF; IF NEW.status = 'validated' AND (NEW.static_validation IS NULL OR OLD.static_validation IS NOT NULL) THEN RAISE EXCEPTION 'the draft→validated transition must write static-validation evidence exactly once (program %)', OLD.id; END IF; IF NEW.status = 'usable' AND (NEW.runtime_tests IS NULL OR OLD.runtime_tests IS NOT NULL OR (NEW.runtime_tests->>'passed')::boolean IS NOT TRUE) THEN RAISE EXCEPTION 'the validated→usable transition must write passing runtime-test evidence exactly once (program %)', OLD.id; END IF; IF NEW.status = 'rejected' AND (NEW.rejection IS NULL OR OLD.rejection IS NOT NULL) THEN RAISE EXCEPTION 'a rejection must write rejection evidence exactly once (program %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER synthesized_programs_lifecycle_guard
    BEFORE UPDATE ON tools.synthesized_programs
    FOR EACH ROW EXECUTE FUNCTION tools.synthesized_programs_lifecycle();

CREATE OR REPLACE FUNCTION tools.synthesized_programs_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.synthesized_programs rows are never deleted (program %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER synthesized_programs_no_delete_guard
    BEFORE DELETE ON tools.synthesized_programs
    FOR EACH ROW EXECUTE FUNCTION tools.synthesized_programs_no_delete();

-- ---------------------------------------------------------------------------
-- WORK-018 sandbox extension: durable bounded output evidence.
-- ---------------------------------------------------------------------------

ALTER TABLE sandbox.sandbox_executions
    ADD COLUMN output jsonb;

COMMENT ON COLUMN sandbox.sandbox_executions.output IS 'WORK-018: the bounded provider observation output (e.g. {exitCode, stdout, stderr, durationMs}), written once by the dispatching→completed/failed finalization; terminal rows are physically immutable so the output evidence is write-once';
