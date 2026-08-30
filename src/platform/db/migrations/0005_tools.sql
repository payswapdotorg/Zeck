-- WORK-010 — Governed tool runtime.
--
-- Durable tool invocation evidence (acceptance criterion 3): every governed
-- tool invocation — admitted or denied — is ONE row here, bound to its
-- parent execution, carrying the request (identity, fingerprint, input
-- digest, artifact references), the admission evidence (effective policy
-- identity + restriction digest, capability satisfaction, budget operation),
-- the normalized outcome, timing, ledger sequence bindings and the error
-- class.
--
-- Physical invariants enforced here (the WORK-004/0004 discipline of making
-- violations UNREPRESENTABLE, not merely discouraged):
--
--   * the request idempotency anchor is the UNIQUE (application_id,
--     invocation_key): one durable row per logical invocation; concurrent
--     identical requests converge through the unique-index arbitration;
--   * the OUTCOME vocabulary is the TOOL AXIS ONLY — outcome_class ∈
--     {tool-success, tool-failure} or NULL. The verification vocabulary
--     (PASS | FAIL | INCONCLUSIVE) and the provider-axis classes are
--     UNREPRESENTABLE here: "classify a tool failure as verification
--     success" is rejected by the storage boundary itself;
--   * denial classes are the admission authorities (policy | budget |
--     capability); failure classes are the tool axis; both are CHECK-bound;
--   * status/outcome shape consistency is pinned: denied rows carry denial
--     fields and no outcome; succeeded/tool-failed rows carry outcome,
--     dispatch/completion timing and duration; dispatching rows carry none
--     of those yet;
--   * rows are NEVER deleted; terminal rows (denied | succeeded |
--     tool-failed) are PHYSICALLY immutable; the only legal UPDATE is on a
--     dispatching row (ledger-sequence bookkeeping, or the exactly-once
--     finalization dispatching → succeeded | tool-failed);
--   * tenant scoping uses composite FKs like migrations 0002/0003/0004:
--     (application_id, tenant_id) -> applications.applications and
--     (execution_id, application_id) -> executions.executions, so a
--     cross-tenant or cross-application invocation row is unrepresentable.
--
-- Migration-runner statement rule (see runner.ts): statements are split on
-- `;` at end of line — every trigger function body below is a single line
-- with no embedded `;` line endings.

CREATE SCHEMA tools;

-- ---------------------------------------------------------------------------
-- Tool invocations (owned by the tools module): the governed-tool evidence
-- journal. NOT a state machine — the execution lifecycle authority stays in
-- executions.executions; this row records one tool observation boundary.
-- ---------------------------------------------------------------------------

CREATE TABLE tools.tool_invocations (
    id                     uuid PRIMARY KEY,
    application_id         uuid NOT NULL,
    tenant_id              uuid NOT NULL,
    execution_id           uuid NOT NULL,
    invocation_key         text NOT NULL,
    request_fingerprint    text NOT NULL,
    tool_id                text NOT NULL,
    tool_version           text NOT NULL,
    capability_id          text NOT NULL,
    status                 text NOT NULL,
    outcome_class          text,
    denial_class           text,
    denial_code            text,
    denial_reason          text,
    failure_class          text,
    failure_message        text,
    retryable              boolean NOT NULL DEFAULT false,
    input_digest           text NOT NULL,
    input_artifacts        jsonb NOT NULL DEFAULT '[]'::jsonb,
    output                 jsonb,
    output_artifacts       jsonb NOT NULL DEFAULT '[]'::jsonb,
    usage_micro_usd        text,
    budget_operation_id    text,
    policy_evidence        jsonb,
    capability_satisfaction text,
    requested_at           timestamptz NOT NULL DEFAULT now(),
    dispatched_at          timestamptz,
    completed_at           timestamptz,
    duration_ms            integer,
    ledger_requested_sequence integer,
    ledger_result_sequence integer,
    CONSTRAINT tool_invocations_status_vocabulary CHECK (
        status IN ('denied', 'dispatching', 'succeeded', 'tool-failed')
    ),
    -- THE tool-axis outcome vocabulary: verification classes (PASS / FAIL /
    -- INCONCLUSIVE) and provider-axis classes are physically excluded.
    CONSTRAINT tool_invocations_outcome_vocabulary CHECK (
        outcome_class IS NULL OR outcome_class IN ('tool-success', 'tool-failure')
    ),
    CONSTRAINT tool_invocations_denial_vocabulary CHECK (
        denial_class IS NULL OR denial_class IN ('policy', 'budget', 'capability')
    ),
    CONSTRAINT tool_invocations_failure_vocabulary CHECK (
        failure_class IS NULL OR failure_class IN (
            'tool-execution', 'output-contract', 'adapter-error', 'timeout', 'unknown-outcome'
        )
    ),
    CONSTRAINT tool_invocations_denial_code_vocabulary CHECK (
        denial_code IS NULL OR denial_code IN ('POLICY_DENIED', 'BUDGET_EXCEEDED', 'CAPABILITY_UNAVAILABLE')
    ),
    -- Shape consistency per status (denial/outcome disjointness):
    CONSTRAINT tool_invocations_denied_shape CHECK (
        (status = 'denied') = (denial_class IS NOT NULL AND denial_code IS NOT NULL)
    ),
    CONSTRAINT tool_invocations_outcome_shape CHECK (
        (status IN ('succeeded', 'tool-failed')) = (outcome_class IS NOT NULL AND completed_at IS NOT NULL AND dispatched_at IS NOT NULL)
    ),
    CONSTRAINT tool_invocations_dispatching_shape CHECK (
        (status = 'dispatching') = (outcome_class IS NULL AND denial_class IS NULL AND failure_class IS NULL AND completed_at IS NULL AND dispatched_at IS NULL)
    ),
    CONSTRAINT tool_invocations_succeeded_shape CHECK (
        status <> 'succeeded' OR (outcome_class = 'tool-success' AND failure_class IS NULL)
    ),
    CONSTRAINT tool_invocations_failed_shape CHECK (
        status <> 'tool-failed' OR (outcome_class = 'tool-failure' AND failure_class IS NOT NULL)
    ),
    CONSTRAINT tool_invocations_outcome_never_denied CHECK (
        denial_class IS NULL OR (outcome_class IS NULL AND failure_class IS NULL)
    ),
    CONSTRAINT tool_invocations_usage_shape CHECK (
        usage_micro_usd IS NULL OR usage_micro_usd ~ '^\d{1,19}$'
    ),
    CONSTRAINT tool_invocations_duration_shape CHECK (
        duration_ms IS NULL OR duration_ms >= 0
    ),
    CONSTRAINT tool_invocations_ledger_sequences CHECK (
        (ledger_requested_sequence IS NULL OR ledger_requested_sequence >= 1)
        AND (ledger_result_sequence IS NULL OR ledger_result_sequence >= 1)
    ),
    CONSTRAINT tool_invocations_identities_nonempty CHECK (
        length(tool_id) BETWEEN 1 AND 100
        AND length(tool_version) BETWEEN 1 AND 32
        AND length(capability_id) BETWEEN 1 AND 100
        AND length(invocation_key) BETWEEN 1 AND 200
        AND length(request_fingerprint) BETWEEN 1 AND 500
        AND length(input_digest) BETWEEN 1 AND 128
    ),
    CONSTRAINT tool_invocations_input_artifacts_shape CHECK (
        jsonb_typeof(input_artifacts) = 'array'
    ),
    CONSTRAINT tool_invocations_output_artifacts_shape CHECK (
        jsonb_typeof(output_artifacts) = 'array'
    ),
    CONSTRAINT tool_invocations_output_shape CHECK (
        output IS NULL OR jsonb_typeof(output) = 'object'
    ),
    CONSTRAINT tool_invocations_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT tool_invocations_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    -- The request idempotency anchor: one durable row per logical invocation.
    CONSTRAINT tool_invocations_request_key UNIQUE (application_id, invocation_key)
);

CREATE INDEX tool_invocations_by_execution
    ON tools.tool_invocations (application_id, execution_id, requested_at);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION tools.tool_invocations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tools.tool_invocations rows are never deleted (invocation %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tool_invocations_no_delete
    BEFORE DELETE ON tools.tool_invocations
    FOR EACH ROW EXECUTE FUNCTION tools.tool_invocations_no_delete();

-- Terminal rows are physically immutable; a dispatching row may only take
-- ledger-sequence bookkeeping or finalize EXACTLY ONCE into a tool-axis
-- terminal status (denied is insert-only; it is unreachable by UPDATE).
-- The status/shape CHECK constraints above pin WHICH fields each status
-- may carry, so this trigger only needs the transition vocabulary.
CREATE OR REPLACE FUNCTION tools.tool_invocations_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('denied', 'succeeded', 'tool-failed') THEN RAISE EXCEPTION 'tools.tool_invocations is terminal-immutable in state % (invocation %)', OLD.status, OLD.id; END IF; IF NEW.status NOT IN ('dispatching', 'succeeded', 'tool-failed') THEN RAISE EXCEPTION 'tool invocation % cannot move to status % (denied is insert-only; dispatching finalizes to succeeded/tool-failed)', OLD.id, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER tool_invocations_lifecycle_guard
    BEFORE UPDATE ON tools.tool_invocations
    FOR EACH ROW EXECUTE FUNCTION tools.tool_invocations_lifecycle();
