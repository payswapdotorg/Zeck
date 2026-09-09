-- WORK-049 — Execution IR foundation: the durable optimization
-- decision-record store (E1.1 foundation; ADR-0019/ADR-0020).
--
-- PostgreSQL is the SOLE durable authority for optimization decision
-- records (Work Order AC 7). The table is APPEND-ONLY EVIDENCE — never
-- a state machine (no status column, no lifecycle transitions), never
-- an authorization surface. Physical invariants (violations
-- UNREPRESENTABLE, not merely discouraged):
--
--   * rows are PHYSICALLY append-only: UPDATE and DELETE are rejected
--     by trigger (decision evidence is immutable once recorded);
--   * decision identity is content-addressed and UNIQUE per
--     application: a second, different record under a live
--     (application_id, decision_id) dies on the unique index, and the
--     store's idempotent append replays identical content instead;
--   * closed vocabularies are CHECK-bound: transformation basis codes,
--     the hex-digest identities (plan/IR/decision/record digest) and
--     the bounded numeric quality threshold;
--   * provenance columns are NOT NULL and identity-checked in the
--     store adapter on read (both digests re-validated: a tampered or
--     foreign row is rejected, never served);
--   * tenant scoping uses the composite-FK convention (0002/0003/0004):
--     (application_id, tenant_id) -> applications.applications, and an
--     optional execution binding through (execution_id, application_id)
--     -> executions.executions — a cross-tenant or cross-application
--     binding is unrepresentable.
--
-- Migration-runner statement rule (see runner.ts): statements split on
-- `;` at end of line — trigger bodies are single lines with no embedded
-- `;` line endings.

CREATE SCHEMA execution_ir;

CREATE TABLE execution_ir.optimization_decision_records (
    id                       uuid PRIMARY KEY,
    application_id           uuid NOT NULL,
    tenant_id                uuid NOT NULL,
    execution_id             uuid,
    decision_id              text NOT NULL,
    plan_id                  text NOT NULL,
    ir_id                    text NOT NULL,
    plan_revision            integer NOT NULL,
    selected_candidate_id    text NOT NULL,
    quality_threshold        double precision NOT NULL,
    transformation_basis_code text NOT NULL,
    payload                  jsonb NOT NULL,
    record_digest            text NOT NULL,
    recorded_at              timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT decisions_plan_revision_positive CHECK (plan_revision >= 1),
    CONSTRAINT decisions_quality_threshold CHECK (
        quality_threshold >= 0 AND quality_threshold <= 1
    ),
    CONSTRAINT decisions_transformation_basis_vocabulary CHECK (
        transformation_basis_code IN ('identity', 'representation-substitution')
    ),
    CONSTRAINT decisions_identity_hex CHECK (
        decision_id ~ '^[0-9a-f]{64}$'
        AND plan_id ~ '^[0-9a-f]{64}$'
        AND ir_id ~ '^[0-9a-f]{64}$'
        AND record_digest ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT decisions_payload_shape CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT decisions_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT decisions_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    CONSTRAINT decisions_identity_unique UNIQUE (application_id, decision_id)
);

CREATE INDEX decisions_by_plan ON execution_ir.optimization_decision_records (application_id, plan_id);
CREATE INDEX decisions_by_execution ON execution_ir.optimization_decision_records (application_id, execution_id);

-- Physical append-only enforcement (single-line trigger body; runner rule).
CREATE OR REPLACE FUNCTION execution_ir.decisions_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'execution_ir.optimization_decision_records is append-only (rejected % on decision %)', TG_OP, OLD.decision_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER optimization_decisions_no_mutation
    BEFORE UPDATE OR DELETE ON execution_ir.optimization_decision_records
    FOR EACH ROW EXECUTE FUNCTION execution_ir.decisions_append_only();
