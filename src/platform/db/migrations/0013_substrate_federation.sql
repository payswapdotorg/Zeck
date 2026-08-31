-- WORK-031 — Computational substrate federation (CSX-001/CSX-002).
--
-- The durable state of the provider-neutral substrate contract: the
-- immutable versioned substrate records (workload classes, modalities,
-- latency, resource, isolation, side effects, the execution capability
-- claim, the opaque adapter reference).
--
-- AUTHORITY PRESERVATION (ADR-0016 invariants 1-3, CSX-004):
--   * a substrate is a CAPABILITY and an EXECUTION TARGET, not a new
--     top-level authority: the execution capability claim publishes
--     through the EXISTING capability registry (the one claim
--     authority — this table stores the substrate METADATA, not a
--     second capability catalog);
--   * there is NO policy/budget/verification/execution-state surface
--     here: claims are metadata, distinct from authorization to use
--     them; admission happens in the existing authorities at
--     planning/execution time;
--   * vendor specifics never cross: adapter_ref is an OPAQUE neutral
--     reference to the replaceable adapter behind which the vendor
--     lives.
--
-- Physical invariants (violations are UNREPRESENTABLE):
--   * substrate versions are IMMUTABLE: UNIQUE (application,
--     substrate_id, version) arbitrates concurrent publications
--     (identical digest converges; a different digest fails closed);
--     rows are never updated in their identity/metadata core and
--     never deleted (triggers);
--   * the lifecycle is the frozen table (available <-> suspended,
--     either -> retired terminal-immutable) guarded physically;
--   * every row carries tenant identity (never dropped).
--
-- Migration-version discipline (the collision rule, parallel wave):
-- the live inventory at authoring time is 0001..0010 (merged on
-- main); the sibling branches claim 0011 (WORK-018, pushed) and 0012
-- (WORK-023, pushed). The wave pre-assigned numbers by dispatch
-- order: WORK-018 claims 0011, WORK-023 claims 0012, WORK-031 claims
-- 0013 (THIS migration). No other unmerged Work Order claims any
-- number.

CREATE SCHEMA IF NOT EXISTS capabilities;

CREATE TABLE capabilities.substrates (
    id            uuid PRIMARY KEY,
    application_id uuid NOT NULL,
    tenant_id     uuid NOT NULL,
    substrate_id  text NOT NULL,
    version       text NOT NULL,
    workload_classes jsonb NOT NULL,
    modalities    jsonb NOT NULL,
    latency_class text NOT NULL,
    resource      jsonb NOT NULL,
    isolation     text NOT NULL,
    side_effect_classes jsonb NOT NULL,
    execution_capability jsonb NOT NULL,
    adapter_ref   text NOT NULL,
    description   text,
    digest        text NOT NULL,
    status        text NOT NULL,
    created_by    uuid NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT substrates_status_vocabulary CHECK (status IN ('available','suspended','retired')),
    CONSTRAINT substrates_latency_vocabulary CHECK (latency_class IN ('realtime','interactive','asynchronous','batch')),
    CONSTRAINT substrates_isolation_vocabulary CHECK (isolation IN ('none','process','container','microvm','vm','customer-runner')),
    CONSTRAINT substrates_version_format CHECK (version ~ '^\d+\.\d+\.\d+$'),
    CONSTRAINT substrates_workload_classes_array CHECK (jsonb_typeof(workload_classes) = 'array' AND jsonb_array_length(workload_classes) >= 1),
    CONSTRAINT substrates_modalities_array CHECK (jsonb_typeof(modalities) = 'array'),
    CONSTRAINT substrates_side_effects_array CHECK (jsonb_typeof(side_effect_classes) = 'array' AND jsonb_array_length(side_effect_classes) >= 1),
    CONSTRAINT substrates_resource_object CHECK (jsonb_typeof(resource) = 'object'
        AND (resource->>'cpuMilliCores')::bigint BETWEEN 0 AND 64000
        AND (resource->>'memoryMiB')::bigint BETWEEN 0 AND 262144
        AND (resource->>'estimatedDurationMs')::bigint BETWEEN 0 AND 86400000
        AND (resource->>'estimatedCostMicroUsd') ~ '^\d{1,16}$'),
    CONSTRAINT substrates_execution_capability_object CHECK (jsonb_typeof(execution_capability) = 'object'),
    CONSTRAINT substrates_adapter_ref_nonempty CHECK (length(adapter_ref) BETWEEN 1 AND 200),
    CONSTRAINT substrates_digest_nonempty CHECK (length(digest) BETWEEN 1 AND 128),
    CONSTRAINT substrates_description_bounded CHECK (description IS NULL OR length(description) <= 2000),
    CONSTRAINT substrates_identity_unique UNIQUE (application_id, substrate_id, version),
    FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id)
);

CREATE INDEX substrates_scope_listing
    ON capabilities.substrates (application_id, created_at, id);

CREATE INDEX substrates_available_by_workload
    ON capabilities.substrates (application_id, status) WHERE status = 'available';

-- The metadata core is write-once; only the guarded status may move.
CREATE OR REPLACE FUNCTION capabilities.substrates_core_immutable() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.substrate_id <> OLD.substrate_id OR NEW.version <> OLD.version OR NEW.workload_classes IS DISTINCT FROM OLD.workload_classes OR NEW.modalities IS DISTINCT FROM OLD.modalities OR NEW.latency_class <> OLD.latency_class OR NEW.resource IS DISTINCT FROM OLD.resource OR NEW.isolation <> OLD.isolation OR NEW.side_effect_classes IS DISTINCT FROM OLD.side_effect_classes OR NEW.execution_capability IS DISTINCT FROM OLD.execution_capability OR NEW.adapter_ref <> OLD.adapter_ref OR NEW.description IS DISTINCT FROM OLD.description OR NEW.digest <> OLD.digest OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'capabilities.substrates metadata core is immutable (substrate % version %)', OLD.substrate_id, OLD.version; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER substrates_core_guard
    BEFORE UPDATE ON capabilities.substrates
    FOR EACH ROW EXECUTE FUNCTION capabilities.substrates_core_immutable();

-- The frozen lifecycle: available <-> suspended, either -> retired
-- (terminal-immutable).
CREATE OR REPLACE FUNCTION capabilities.substrates_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status = 'retired' THEN RAISE EXCEPTION 'capabilities.substrates is terminal-immutable in state retired (substrate %)', OLD.substrate_id; END IF; IF NOT ((OLD.status = 'available' AND NEW.status IN ('suspended','retired')) OR (OLD.status = 'suspended' AND NEW.status IN ('available','retired'))) THEN RAISE EXCEPTION 'substrate % cannot move from status % to %', OLD.substrate_id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER substrates_lifecycle_guard
    BEFORE UPDATE ON capabilities.substrates
    FOR EACH ROW EXECUTE FUNCTION capabilities.substrates_lifecycle();

CREATE OR REPLACE FUNCTION capabilities.substrates_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'capabilities.substrates rows are never deleted (substrate %)', OLD.substrate_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER substrates_no_delete_guard
    BEFORE DELETE ON capabilities.substrates
    FOR EACH ROW EXECUTE FUNCTION capabilities.substrates_no_delete();
