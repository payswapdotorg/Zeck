-- WORK-032 — Agentic economic actions and provider-neutral payment rails.
--
-- Migration claim (stated, never assumed): 0014 is pre-assigned to
-- WORK-032 by the parallel-wave migration-number audit already performed
-- for this wave — WORK-018=0011, WORK-023=0012, WORK-031=0013, and main
-- owns 0001–0010. No 0011/0012/0013 file exists on this branch; each
-- arrives with its sibling work order's merge. The runner only requires
-- per-branch ascending application, so 0014 applying before its younger
-- siblings on this branch is legal and each file still applies exactly
-- once everywhere.
--
-- The durable state of the governed ECONOMIC-ACTION boundary
-- (ECO-001..ECO-008 / ADR-0018): the provider-neutral economic-action
-- INTENT rows, the bounded single-use payment AUTHORizations, the
-- correlated external SETTLEMENT observations (evidence, never a second
-- Zeck truth source), the DELIVERY observations (evidence the
-- verification authority evaluates), and the append-only per-action
-- event ledger. The durable idempotency arbitration reuses
-- platform.idempotency_records (0001) with application-scoped keys —
-- NO second ledger is created here (ECO-003): money-movement truth stays
-- in budgets.reservations/ledger_entries (0003), execution truth in
-- executions.executions (0004).
--
-- THE FROZEN PRINCIPLE (ADR-0018, physically enforced):
--   intent != authorization != transaction != settlement != verification
-- (there is deliberately no table here that can complete an execution,
-- settle a budget reservation or verify a delivery).
--
-- Physical invariants enforced here (the 0004..0010 discipline of making
-- violations UNREPRESENTABLE, not merely discouraged):
--
--   * economic action identity is UNIQUE (id) and the caller's create
--     idempotency key is UNIQUE per application (application_id,
--     idempotency_key): concurrent duplicate creation converges through
--     the store's ON CONFLICT DO NOTHING arbitration into the typed
--     IDEMPOTENCY_KEY_REUSED failure (the idempotency ledger in 0001
--     arbitrates the replay path itself);
--   * the identity/material core of an action is WRITE-ONCE (physical
--     trigger rejects any UPDATE that would change scope, provenance,
--     recipient, amount bounds, currency, expiry, capabilities or rail
--     preference — recipient/amount/currency/purpose substitution is
--     unrepresentable after the fact); the ONLY mutable fields are
--     status, metadata and updated_at;
--   * the action lifecycle is CHECK-bound and forward-only with
--     terminal-immutable rows (proposed -> authorized|denied|expired,
--     authorized -> executing|expired, executing -> settled|failed);
--     rows are never deleted;
--   * ONE authorization per action and ONE per reservation operation
--     (UNIQUE constraints — double budget reservation is
--     unrepresentable, ECO-003); authorizations are write-once apart
--     from status/consumed_at, single-use by vocabulary
--     (consumed_at IS NOT NULL iff status = 'consumed'), and expire no
--     later than their action (trigger — bounded authorization, ECO-002);
--   * settlement convergence is UNIQUE (application_id, rail_id,
--     rail_transaction_ref): duplicate settlement from retries converges
--     on ONE durable observation (the store's ON CONFLICT DO NOTHING
--     path); rows are append-only evidence — nothing here settles a
--     budget, consumes an authorization or completes an execution;
--   * delivery observations are append-only evidence with a closed kind
--     vocabulary; the verification authority (0007) alone decides
--     delivery — no settlement status is expressible as a delivery;
--   * the per-action event ledger is PHYSICALLY append-only and GAPLESS
--     (unique (economic_action_id, sequence) + a max+1 sequence
--     trigger), with closed type/cause vocabularies;
--   * tenant scoping uses composite FKs like 0002..0010:
--     (application_id, tenant_id) -> applications.applications,
--     (execution_id, application_id) -> executions.executions (the
--     ECO-007 provenance binding — an economic action without its
--     execution identity is unrepresentable) and child tables bind to
--     (id, application_id) — cross-tenant, cross-application and
--     cross-action rows are unrepresentable.
--
-- Migration-runner statement rule (see runner.ts): statements are split
-- on `;` at end of line — every trigger function body below is a single
-- line with no embedded `;` line endings.

CREATE SCHEMA economics;

-- ---------------------------------------------------------------------------
-- Economic actions (owned by the economics module): the provider-neutral
-- INTENT rows. NOT an authorization, NOT a settlement, NOT verification.
-- ---------------------------------------------------------------------------

CREATE TABLE economics.economic_actions (
    id                     uuid PRIMARY KEY,
    application_id         uuid NOT NULL,
    tenant_id              uuid NOT NULL,
    execution_id           uuid NOT NULL,
    proposed_by            text NOT NULL,
    purpose                text NOT NULL,
    recipient_kind         text NOT NULL,
    recipient_id           text NOT NULL,
    amount_kind            text NOT NULL,
    amount_min_micro_usd   text NOT NULL,
    amount_max_micro_usd   text NOT NULL,
    currency               text NOT NULL,
    expires_at             timestamptz NOT NULL,
    required_capabilities  jsonb NOT NULL DEFAULT '[]'::jsonb,
    rail_preference        text,
    metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
    status                 text NOT NULL,
    idempotency_key        text NOT NULL,
    created_at             timestamptz NOT NULL,
    updated_at             timestamptz NOT NULL,
    CONSTRAINT economic_actions_purpose_vocabulary CHECK (
        purpose IN ('purchase', 'payment', 'transfer', 'refund', 'charge', 'machine-resource')
    ),
    CONSTRAINT economic_actions_currency_vocabulary CHECK (
        currency IN ('usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'chf')
    ),
    CONSTRAINT economic_actions_recipient_kind_vocabulary CHECK (
        recipient_kind IN ('seller', 'merchant', 'provider', 'wallet', 'account')
    ),
    CONSTRAINT economic_actions_status_vocabulary CHECK (
        status IN ('proposed', 'denied', 'authorized', 'executing', 'settled', 'failed', 'expired')
    ),
    CONSTRAINT economic_actions_amount_kind_vocabulary CHECK (
        amount_kind IN ('exact', 'range')
    ),
    -- Integer micro-USD decimal strings ONLY (the budgets 0003 money
    -- discipline; floats and negatives are unrepresentable).
    CONSTRAINT economic_actions_amount_shape CHECK (
        amount_min_micro_usd ~ '^(0|[1-9][0-9]{0,18})$'
        AND amount_max_micro_usd ~ '^(0|[1-9][0-9]{0,18})$'
    ),
    -- Range bounds are ordered; exact pins both bounds to the same amount.
    CONSTRAINT economic_actions_amount_bounds CHECK (
        (amount_kind = 'range' AND amount_min_micro_usd::numeric <= amount_max_micro_usd::numeric)
        OR (amount_kind = 'exact' AND amount_min_micro_usd = amount_max_micro_usd)
    ),
    CONSTRAINT economic_actions_proposed_by_shape CHECK (
        length(proposed_by) BETWEEN 1 AND 255
    ),
    CONSTRAINT economic_actions_recipient_shape CHECK (
        length(recipient_id) BETWEEN 1 AND 512
    ),
    CONSTRAINT economic_actions_rail_preference_shape CHECK (
        rail_preference IS NULL OR (length(rail_preference) BETWEEN 1 AND 255)
    ),
    CONSTRAINT economic_actions_capabilities_shape CHECK (
        jsonb_typeof(required_capabilities) = 'array'
    ),
    CONSTRAINT economic_actions_metadata_shape CHECK (
        jsonb_typeof(metadata) = 'object'
    ),
    -- The caller's create idempotency key (bounded like the 0001 ledger
    -- it is also recorded in).
    CONSTRAINT economic_actions_idempotency_key_shape CHECK (
        length(idempotency_key) BETWEEN 1 AND 255
    ),
    CONSTRAINT economic_actions_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    -- ECO-007 provenance: every economic action is bound to its logical
    -- execution on the canonical ledger.
    CONSTRAINT economic_actions_execution_fk
        FOREIGN KEY (execution_id, application_id)
        REFERENCES executions.executions (id, application_id),
    -- Composite identity for child-table references (authorizations,
    -- settlements, deliveries, events bind to THIS application's action).
    CONSTRAINT economic_actions_scope_key UNIQUE (id, application_id),
    -- One durable action per caller create key per application.
    CONSTRAINT economic_actions_request_key UNIQUE (application_id, idempotency_key)
);

CREATE INDEX economic_actions_by_application
    ON economics.economic_actions (application_id, created_at);

CREATE INDEX economic_actions_by_execution
    ON economics.economic_actions (application_id, execution_id, created_at);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION economics.economic_actions_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'economics.economic_actions rows are never deleted (action %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER economic_actions_no_delete
    BEFORE DELETE ON economics.economic_actions
    FOR EACH ROW EXECUTE FUNCTION economics.economic_actions_no_delete();

-- Write-once identity/material core: the ONLY mutable fields are status,
-- metadata and updated_at (the guarded lifecycle writes). Scope,
-- provenance, recipient, amount bounds, currency, purpose, expiry,
-- capabilities and rail preference are physically immutable — a mutated
-- material constraint is a DIFFERENT action, not an edit.
CREATE OR REPLACE FUNCTION economics.economic_actions_immutable_identity() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.execution_id <> OLD.execution_id OR NEW.proposed_by <> OLD.proposed_by OR NEW.purpose <> OLD.purpose OR NEW.recipient_kind <> OLD.recipient_kind OR NEW.recipient_id <> OLD.recipient_id OR NEW.amount_kind <> OLD.amount_kind OR NEW.amount_min_micro_usd <> OLD.amount_min_micro_usd OR NEW.amount_max_micro_usd <> OLD.amount_max_micro_usd OR NEW.currency <> OLD.currency OR NEW.expires_at <> OLD.expires_at OR NEW.required_capabilities IS DISTINCT FROM OLD.required_capabilities OR NEW.rail_preference IS DISTINCT FROM OLD.rail_preference OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'economics.economic_actions identity and material constraints are immutable (action %); propose a new action instead', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER economic_actions_immutable_identity_guard
    BEFORE UPDATE ON economics.economic_actions
    FOR EACH ROW EXECUTE FUNCTION economics.economic_actions_immutable_identity();

-- Forward-only frozen lifecycle; terminal rows (denied | settled |
-- failed | expired) are physically immutable.
CREATE OR REPLACE FUNCTION economics.economic_actions_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('denied', 'settled', 'failed', 'expired') THEN RAISE EXCEPTION 'economics.economic_actions is terminal-immutable in state % (action %)', OLD.status, OLD.id; END IF; IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('authorized', 'denied', 'expired')) OR (OLD.status = 'authorized' AND NEW.status IN ('executing', 'expired')) OR (OLD.status = 'executing' AND NEW.status IN ('settled', 'failed'))) THEN RAISE EXCEPTION 'economic action % cannot move from status % to % (the lifecycle is frozen and forward-only)', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER economic_actions_lifecycle_guard
    BEFORE UPDATE ON economics.economic_actions
    FOR EACH ROW EXECUTE FUNCTION economics.economic_actions_lifecycle();

-- ---------------------------------------------------------------------------
-- Bounded payment authorizations (owned by the economics module): the
-- tokenized authorization seam (ECO-002). NOT a credential — there is no
-- column where a card number, key or secret could even appear — and NOT
-- a settlement. One per action, one per budget reservation operation.
-- ---------------------------------------------------------------------------

CREATE TABLE economics.payment_authorizations (
    id                      uuid PRIMARY KEY,
    economic_action_id      uuid NOT NULL,
    application_id          uuid NOT NULL,
    tenant_id               uuid NOT NULL,
    constraints             jsonb NOT NULL,
    status                  text NOT NULL,
    reservation_operation_id text NOT NULL,
    admission_evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
    issued_at               timestamptz NOT NULL,
    expires_at              timestamptz NOT NULL,
    consumed_at             timestamptz,
    created_at              timestamptz NOT NULL,
    CONSTRAINT payment_authorizations_status_vocabulary CHECK (
        status IN ('active', 'consumed', 'expired', 'revoked')
    ),
    CONSTRAINT payment_authorizations_constraints_shape CHECK (
        jsonb_typeof(constraints) = 'object'
    ),
    CONSTRAINT payment_authorizations_admission_evidence_shape CHECK (
        jsonb_typeof(admission_evidence) = 'object'
    ),
    CONSTRAINT payment_authorizations_reservation_shape CHECK (
        length(reservation_operation_id) BETWEEN 1 AND 200
    ),
    -- Hard expiry strictly after issuance (bounded authorization).
    CONSTRAINT payment_authorizations_expiry_shape CHECK (
        expires_at > issued_at
    ),
    -- Single-use by construction: consumed iff the consumption instant is
    -- recorded (a consumed authorization can never return to active).
    CONSTRAINT payment_authorizations_consumed_shape CHECK (
        (status = 'consumed') = (consumed_at IS NOT NULL)
    ),
    CONSTRAINT payment_authorizations_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT payment_authorizations_action_fk
        FOREIGN KEY (economic_action_id, application_id)
        REFERENCES economics.economic_actions (id, application_id),
    -- Composite identity for settlement references.
    CONSTRAINT payment_authorizations_scope_key UNIQUE (id, application_id),
    -- ONE authorization per action (the action lifecycle enforces the
    -- same single-issuance semantics from the other side).
    CONSTRAINT payment_authorizations_action_key UNIQUE (economic_action_id),
    -- ONE authorization per budget reservation operation — double
    -- reservation is unrepresentable (ECO-003).
    CONSTRAINT payment_authorizations_reservation_key UNIQUE (reservation_operation_id)
);

CREATE INDEX payment_authorizations_by_application
    ON economics.payment_authorizations (application_id, created_at);

-- Rows are never deleted.
CREATE OR REPLACE FUNCTION economics.payment_authorizations_no_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'economics.payment_authorizations rows are never deleted (authorization %)', OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payment_authorizations_no_delete
    BEFORE DELETE ON economics.payment_authorizations
    FOR EACH ROW EXECUTE FUNCTION economics.payment_authorizations_no_delete();

-- Write-once apart from the guarded status/consumed_at transition: the
-- constraint set, the reservation binding and the admission evidence are
-- physically immutable (a minted authorization can never be re-scoped).
CREATE OR REPLACE FUNCTION economics.payment_authorizations_immutable_constraints() RETURNS trigger AS $$ BEGIN IF NEW.id <> OLD.id OR NEW.economic_action_id <> OLD.economic_action_id OR NEW.application_id <> OLD.application_id OR NEW.tenant_id <> OLD.tenant_id OR NEW.constraints IS DISTINCT FROM OLD.constraints OR NEW.reservation_operation_id <> OLD.reservation_operation_id OR NEW.admission_evidence IS DISTINCT FROM OLD.admission_evidence OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'economics.payment_authorizations constraints are immutable (authorization %)', OLD.id; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payment_authorizations_immutable_constraints_guard
    BEFORE UPDATE ON economics.payment_authorizations
    FOR EACH ROW EXECUTE FUNCTION economics.payment_authorizations_immutable_constraints();

-- Forward-only, terminal-immutable authorization lifecycle: only an
-- active authorization may move, and only to consumed | expired |
-- revoked (single-use; replay of a consumed authorization dies here too).
CREATE OR REPLACE FUNCTION economics.payment_authorizations_lifecycle() RETURNS trigger AS $$ BEGIN IF OLD.status IN ('consumed', 'expired', 'revoked') THEN RAISE EXCEPTION 'economics.payment_authorizations is terminal-immutable in state % (authorization %)', OLD.status, OLD.id; END IF; IF NOT (OLD.status = 'active' AND NEW.status IN ('consumed', 'expired', 'revoked')) THEN RAISE EXCEPTION 'payment authorization % cannot move from status % to %', OLD.id, OLD.status, NEW.status; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payment_authorizations_lifecycle_guard
    BEFORE UPDATE ON economics.payment_authorizations
    FOR EACH ROW EXECUTE FUNCTION economics.payment_authorizations_lifecycle();

-- Bounded expiry (ECO-002): an authorization NEVER outlives its action's
-- intent expiry — extending a bounded authorization past its action is
-- unrepresentable.
CREATE OR REPLACE FUNCTION economics.payment_authorizations_bounded_expiry() RETURNS trigger AS $$ DECLARE action_expires timestamptz; BEGIN SELECT expires_at INTO action_expires FROM economics.economic_actions WHERE id = NEW.economic_action_id AND application_id = NEW.application_id; IF action_expires IS NULL OR NEW.expires_at > action_expires THEN RAISE EXCEPTION 'payment authorization % expires at %, beyond its economic action expiry %', NEW.id, NEW.expires_at, action_expires; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER payment_authorizations_bounded_expiry_guard
    BEFORE INSERT ON economics.payment_authorizations
    FOR EACH ROW EXECUTE FUNCTION economics.payment_authorizations_bounded_expiry();

-- ---------------------------------------------------------------------------
-- Settlement observations (owned by the economics module): CORRELATED
-- EXTERNAL EVIDENCE of a rail transaction (ECO-006). Append-only; NOT a
-- Zeck truth source — no row here can settle a budget reservation,
-- consume an authorization or complete an execution.
-- ---------------------------------------------------------------------------

CREATE TABLE economics.settlement_observations (
    id                      uuid PRIMARY KEY,
    economic_action_id      uuid NOT NULL,
    authorization_id        uuid,
    application_id          uuid NOT NULL,
    tenant_id               uuid NOT NULL,
    rail_id                 text NOT NULL,
    rail_transaction_ref    text NOT NULL,
    status                  text NOT NULL,
    settled_amount_micro_usd text NOT NULL,
    currency                text NOT NULL,
    observed_at             timestamptz NOT NULL,
    evidence_digest         text NOT NULL,
    recorded_at             timestamptz NOT NULL,
    CONSTRAINT settlement_observations_status_vocabulary CHECK (
        status IN ('observed', 'confirmed', 'failed')
    ),
    CONSTRAINT settlement_observations_currency_vocabulary CHECK (
        currency IN ('usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'chf')
    ),
    CONSTRAINT settlement_observations_amount_shape CHECK (
        settled_amount_micro_usd ~ '^(0|[1-9][0-9]{0,18})$'
    ),
    -- Neutral rail identity + the rail's own opaque transaction
    -- reference (raw protocol payloads are never stored — only the
    -- digest of the neutral evidence).
    CONSTRAINT settlement_observations_rail_shape CHECK (
        length(rail_id) BETWEEN 1 AND 100
        AND length(rail_transaction_ref) BETWEEN 1 AND 500
    ),
    CONSTRAINT settlement_observations_evidence_digest_shape CHECK (
        length(evidence_digest) BETWEEN 1 AND 128
    ),
    CONSTRAINT settlement_observations_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT settlement_observations_action_fk
        FOREIGN KEY (economic_action_id, application_id)
        REFERENCES economics.economic_actions (id, application_id),
    -- Correlation with the authorization that caused the charge (NULL
    -- for out-of-band external observations — correlated evidence only).
    CONSTRAINT settlement_observations_authorization_fk
        FOREIGN KEY (authorization_id, application_id)
        REFERENCES economics.payment_authorizations (id, application_id),
    -- Settlement convergence: ONE durable observation per external rail
    -- transaction per application (duplicate settlement from retries
    -- converges here — the store's ON CONFLICT target).
    CONSTRAINT settlement_observations_convergence_key UNIQUE (application_id, rail_id, rail_transaction_ref)
);

CREATE INDEX settlement_observations_by_action
    ON economics.settlement_observations (application_id, economic_action_id);

-- Append-only evidence.
CREATE OR REPLACE FUNCTION economics.settlement_observations_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'economics.settlement_observations is append-only evidence (rejected % on settlement %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_observations_no_mutation
    BEFORE UPDATE OR DELETE ON economics.settlement_observations
    FOR EACH ROW EXECUTE FUNCTION economics.settlement_observations_append_only();

-- ---------------------------------------------------------------------------
-- Delivery observations (owned by the economics module): EVIDENCE that
-- the paid-for resource/service was (or was not) delivered. Append-only;
-- the verification authority (0007) alone decides delivery — settlement
-- is never delivery evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE economics.delivery_observations (
    id                  uuid PRIMARY KEY,
    economic_action_id  uuid NOT NULL,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    kind                text NOT NULL,
    digest              text NOT NULL,
    content_ref         text NOT NULL,
    observed_at         timestamptz NOT NULL,
    recorded_at         timestamptz NOT NULL,
    CONSTRAINT delivery_observations_kind_vocabulary CHECK (
        kind IN ('resource-receipt', 'http-delivery', 'service-result')
    ),
    CONSTRAINT delivery_observations_digest_shape CHECK (
        length(digest) BETWEEN 1 AND 256
    ),
    CONSTRAINT delivery_observations_content_ref_shape CHECK (
        length(content_ref) BETWEEN 1 AND 1024
    ),
    CONSTRAINT delivery_observations_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT delivery_observations_action_fk
        FOREIGN KEY (economic_action_id, application_id)
        REFERENCES economics.economic_actions (id, application_id)
);

CREATE INDEX delivery_observations_by_action
    ON economics.delivery_observations (application_id, economic_action_id, recorded_at);

-- Append-only evidence.
CREATE OR REPLACE FUNCTION economics.delivery_observations_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'economics.delivery_observations is append-only evidence (rejected % on delivery %)', TG_OP, OLD.id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER delivery_observations_no_mutation
    BEFORE UPDATE OR DELETE ON economics.delivery_observations
    FOR EACH ROW EXECUTE FUNCTION economics.delivery_observations_append_only();

-- ---------------------------------------------------------------------------
-- Economic action events (owned by the economics module): the append-only
-- per-action provenance ledger (ECO-007). Gapless per action, physically
-- append-only. Execution-bound evidence ADDITIONALLY rides the canonical
-- executions ledger (0004) through its own recordStepEvent seam.
-- ---------------------------------------------------------------------------

CREATE TABLE economics.economic_action_events (
    event_id            uuid PRIMARY KEY,
    economic_action_id  uuid NOT NULL,
    application_id      uuid NOT NULL,
    tenant_id           uuid NOT NULL,
    sequence            integer NOT NULL,
    type                text NOT NULL,
    cause               text NOT NULL,
    reference           jsonb NOT NULL DEFAULT '{}'::jsonb,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at         timestamptz NOT NULL,
    CONSTRAINT economic_action_events_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT economic_action_events_type_vocabulary CHECK (
        type IN (
            'action.recorded', 'action.denied',
            'authorization.issued', 'authorization.consumed', 'authorization.expired',
            'payment.dispatched', 'payment.rejected',
            'settlement.correlated', 'settlement.externally-recorded',
            'delivery.recorded'
        )
    ),
    -- Provenance cause classes (who/what produced the event): the
    -- admission authorities (policy | capability | budget), the rails,
    -- the platform, the bounded-authorization firewall, external
    -- out-of-band observation, delivery evidence and the caller.
    CONSTRAINT economic_action_events_cause_vocabulary CHECK (
        cause IN (
            'economic-intent', 'policy', 'capability', 'budget', 'rail',
            'platform', 'authorization', 'external', 'delivery-evidence', 'caller'
        )
    ),
    CONSTRAINT economic_action_events_reference_shape CHECK (
        jsonb_typeof(reference) = 'object'
    ),
    CONSTRAINT economic_action_events_payload_shape CHECK (
        jsonb_typeof(payload) = 'object'
    ),
    CONSTRAINT economic_action_events_tenant_fk
        FOREIGN KEY (application_id, tenant_id)
        REFERENCES applications.applications (id, tenant_id),
    CONSTRAINT economic_action_events_action_fk
        FOREIGN KEY (economic_action_id, application_id)
        REFERENCES economics.economic_actions (id, application_id),
    -- Gapless per action: no duplicate and no out-of-order sequence.
    CONSTRAINT economic_action_events_sequence_key UNIQUE (economic_action_id, sequence)
);

-- Physical append-only enforcement.
CREATE OR REPLACE FUNCTION economics.economic_action_events_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'economics.economic_action_events is append-only (rejected % on event %)', TG_OP, OLD.event_id; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER economic_action_events_no_mutation
    BEFORE UPDATE OR DELETE ON economics.economic_action_events
    FOR EACH ROW EXECUTE FUNCTION economics.economic_action_events_append_only();

-- Physical gapless sequence: an insert must take the NEXT per-action
-- sequence (max + 1); a gap or a replayed/duplicate sequence is rejected
-- before it commits (duplicates additionally die on the unique key).
CREATE OR REPLACE FUNCTION economics.economic_action_events_gapless_sequence() RETURNS trigger AS $$ DECLARE expected integer; BEGIN SELECT COALESCE(MAX(sequence), 0) + 1 INTO expected FROM economics.economic_action_events WHERE economic_action_id = NEW.economic_action_id; IF NEW.sequence IS DISTINCT FROM expected THEN RAISE EXCEPTION 'economic_action_events sequence must be gapless per action (action % expected sequence %, got %)', NEW.economic_action_id, expected, NEW.sequence; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER economic_action_events_gapless_sequence
    BEFORE INSERT ON economics.economic_action_events
    FOR EACH ROW EXECUTE FUNCTION economics.economic_action_events_gapless_sequence();
