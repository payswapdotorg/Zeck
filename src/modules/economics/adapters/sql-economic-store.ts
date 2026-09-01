/**
 * SQL adapter for the economics module (WORK-032; migration 0014).
 *
 * Bridges `EconomicStore` and the module `EconomicsIdempotencyPort` to
 * the provider-neutral platform `DatabasePort`. No driver/SDK import
 * happens here — `pg` is owned by the platform DB layer (SDK boundary
 * table).
 *
 * The idempotency ledger reuses `platform.idempotency_records` (migration
 * 0001) with application-scoped arbitration keys — the same durable
 * arbitration contract as auth/applications/connections/budgets/
 * executions (`spec/contracts.md` "Idempotency response rule").
 *
 * Physical invariants (migration 0014 triggers/constraints, mirrored
 * here as typed failures): write-once identity cores on actions and
 * authorizations, forward-only status transitions with terminal
 * immutability, one authorization per action + per reservation
 * operation, settlement convergence on (application, rail, ref),
 * append-only deliveries/events, gapless per-action event sequences.
 * Guarded transitions re-derive current status under a row lock
 * (`FOR UPDATE`) — never from a pre-lock read.
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { PaymentAuthorizationRecord } from "../domain/authorization";
import type { EconomicActionRecord, EconomicActionStatus } from "../domain/economic-action";
import { economicActionCanTransition } from "../domain/economic-action";
import type { EconomicActionEvent } from "../domain/events";
import type { DeliveryObservationRecord, SettlementObservationRecord } from "../domain/settlement";
import type { RecipientKind } from "../domain/vocabulary";
import type {
  EconomicsIdempotencyArbitration,
  EconomicsIdempotencyPort,
  EconomicsIdempotencyScope,
  EconomicsTx,
} from "../ports/economic-idempotency";
import type {
  EconomicStore,
  InsertAuthorizationInput,
  InsertDeliveryInput,
  InsertEconomicActionInput,
  InsertEventInput,
  InsertSettlementInput,
} from "../ports/economic-store";

type Executor = Pick<DatabasePort, "execute">;

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

interface ActionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly proposed_by: string;
  readonly purpose: string;
  readonly recipient_kind: string;
  readonly recipient_id: string;
  readonly amount_kind: string;
  readonly amount_min_micro_usd: string;
  readonly amount_max_micro_usd: string;
  readonly currency: string;
  readonly expires_at: Date | string;
  readonly required_capabilities: unknown;
  readonly rail_preference: string | null;
  readonly metadata: unknown;
  readonly status: string;
  readonly idempotency_key: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const ACTION_COLUMNS = `id, application_id, tenant_id, execution_id, proposed_by, purpose, recipient_kind, recipient_id, amount_kind, amount_min_micro_usd, amount_max_micro_usd, currency, expires_at, required_capabilities, rail_preference, metadata, status, idempotency_key, created_at, updated_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toAction(row: ActionRow): EconomicActionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    proposedBy: row.proposed_by,
    purpose: row.purpose as EconomicActionRecord["purpose"],
    recipient: { kind: row.recipient_kind as RecipientKind, id: row.recipient_id },
    amount:
      row.amount_kind === "exact"
        ? { kind: "exact", microUsd: row.amount_min_micro_usd }
        : {
            kind: "range",
            minMicroUsd: row.amount_min_micro_usd,
            maxMicroUsd: row.amount_max_micro_usd,
          },
    currency: row.currency as EconomicActionRecord["currency"],
    expiresAt: iso(row.expires_at),
    requiredCapabilities: (row.required_capabilities ??
      []) as EconomicActionRecord["requiredCapabilities"],
    railPreference: row.rail_preference,
    metadata: (row.metadata ?? {}) as Readonly<Record<string, unknown>>,
    status: row.status as EconomicActionStatus,
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

interface AuthorizationRow {
  readonly id: string;
  readonly economic_action_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly constraints: unknown;
  readonly status: string;
  readonly reservation_operation_id: string;
  readonly admission_evidence: unknown;
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly consumed_at: Date | string | null;
  readonly created_at: Date | string;
}

const AUTHORIZATION_COLUMNS = `id, economic_action_id, application_id, tenant_id, constraints, status, reservation_operation_id, admission_evidence, issued_at, expires_at, consumed_at, created_at`;

function toAuthorization(row: AuthorizationRow): PaymentAuthorizationRecord {
  return {
    id: row.id,
    economicActionId: row.economic_action_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    constraints: row.constraints as unknown as PaymentAuthorizationRecord["constraints"],
    status: row.status as PaymentAuthorizationRecord["status"],
    reservationOperationId: row.reservation_operation_id,
    admissionEvidence: (row.admission_evidence ?? {}) as Readonly<Record<string, unknown>>,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    consumedAt: row.consumed_at === null ? null : iso(row.consumed_at),
    createdAt: iso(row.created_at),
  };
}

interface SettlementRow {
  readonly id: string;
  readonly economic_action_id: string;
  readonly authorization_id: string | null;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly rail_id: string;
  readonly rail_transaction_ref: string;
  readonly status: string;
  readonly settled_amount_micro_usd: string;
  readonly currency: string;
  readonly observed_at: Date | string;
  readonly evidence_digest: string;
  readonly recorded_at: Date | string;
}

const SETTLEMENT_COLUMNS = `id, economic_action_id, authorization_id, application_id, tenant_id, rail_id, rail_transaction_ref, status, settled_amount_micro_usd, currency, observed_at, evidence_digest, recorded_at`;

function toSettlement(row: SettlementRow): SettlementObservationRecord {
  return {
    id: row.id,
    economicActionId: row.economic_action_id,
    authorizationId: row.authorization_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    railId: row.rail_id,
    railTransactionRef: row.rail_transaction_ref,
    status: row.status as SettlementObservationRecord["status"],
    settledAmountMicroUsd: row.settled_amount_micro_usd,
    currency: row.currency as SettlementObservationRecord["currency"],
    observedAt: iso(row.observed_at),
    evidenceDigest: row.evidence_digest,
    recordedAt: iso(row.recorded_at),
  };
}

interface DeliveryRow {
  readonly id: string;
  readonly economic_action_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly digest: string;
  readonly content_ref: string;
  readonly observed_at: Date | string;
  readonly recorded_at: Date | string;
}

const DELIVERY_COLUMNS = `id, economic_action_id, application_id, tenant_id, kind, digest, content_ref, observed_at, recorded_at`;

function toDelivery(row: DeliveryRow): DeliveryObservationRecord {
  return {
    id: row.id,
    economicActionId: row.economic_action_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    kind: row.kind as DeliveryObservationRecord["kind"],
    digest: row.digest,
    contentRef: row.content_ref,
    observedAt: iso(row.observed_at),
    recordedAt: iso(row.recorded_at),
  };
}

interface EventRow {
  readonly event_id: string;
  readonly economic_action_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly cause: string;
  readonly reference: unknown;
  readonly payload: unknown;
  readonly occurred_at: Date | string;
}

const EVENT_COLUMNS = `event_id, economic_action_id, application_id, tenant_id, sequence, type, cause, reference, payload, occurred_at`;

function toEvent(row: EventRow): EconomicActionEvent {
  return {
    eventId: row.event_id,
    economicActionId: row.economic_action_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sequence: Number(row.sequence),
    type: row.type as EconomicActionEvent["type"],
    cause: row.cause,
    reference: (row.reference ?? {}) as Readonly<Record<string, unknown>>,
    payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
    occurredAt: iso(row.occurred_at),
  };
}

export class SqlEconomicStore implements EconomicStore {
  constructor(private readonly executor: Executor) {}

  async insertEconomicAction(input: InsertEconomicActionInput): Promise<EconomicActionRecord> {
    const result = await this.executor.execute<ActionRow>({
      // ON CONFLICT DO NOTHING (untargeted: the id primary key OR the
      // (application_id, idempotency_key) request key) converges duplicate
      // inserts into the typed IDEMPOTENCY_KEY_REUSED failure below — the
      // same write-once identity arbitration as the sibling stores.
      sql: `INSERT INTO economics.economic_actions (${ACTION_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17, $18, $19, $19)
ON CONFLICT DO NOTHING
RETURNING ${ACTION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.proposedBy,
        input.purpose,
        input.recipientKind,
        input.recipientId,
        input.amountKind,
        input.amountMinMicroUsd,
        input.amountMaxMicroUsd,
        input.currency,
        input.expiresAt,
        JSON.stringify(input.requiredCapabilities),
        input.railPreference,
        JSON.stringify(input.metadata),
        input.status,
        input.idempotencyKey,
        input.createdAt,
      ],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "economic action identity or idempotency key already exists",
        details: { id: input.id },
      });
    }
    return toAction(row);
  }

  async getEconomicAction(applicationId: string, id: string): Promise<EconomicActionRecord | null> {
    const result = await this.executor.execute<ActionRow>({
      sql: `SELECT ${ACTION_COLUMNS} FROM economics.economic_actions WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, id],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAction(row);
  }

  async transitionEconomicAction(
    applicationId: string,
    id: string,
    from: readonly string[],
    to: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<EconomicActionRecord> {
    // The port contract: derive the row's CURRENT status (never trust the
    // caller's pre-read) and guard the write on it. Inside the arbitration
    // transaction this SELECT is immediately followed by the guarded
    // UPDATE on the same locked row; the conditional UPDATE is the final
    // arbiter either way (a lost race updates zero rows -> typed failure).
    const current = await this.getEconomicAction(applicationId, id);
    if (current === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "economic action not found in this application",
        details: { id },
      });
    }
    if (!from.includes(current.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `economic action is ${current.status}; expected one of ${from.join(", ")}`,
        details: { id, status: current.status },
      });
    }
    if (!economicActionCanTransition(current.status, to as EconomicActionStatus)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `economic action transition ${current.status} -> ${to} is not in the frozen lifecycle`,
        details: { id, from: current.status, to },
      });
    }
    const sets: string[] = ["status = $3", "updated_at = $4"];
    const parameters: unknown[] = [
      applicationId,
      id,
      to,
      patch.updatedAt ?? new Date().toISOString(),
    ];
    if (patch.metadata !== undefined) {
      parameters.push(JSON.stringify(patch.metadata));
      sets.push(`metadata = $${parameters.length}::jsonb`);
    }
    const result = await this.executor.execute<ActionRow>({
      sql: `UPDATE economics.economic_actions SET ${sets.join(", ")}
WHERE application_id = $1 AND id = $2 AND status = ANY($${parameters.length + 1})
RETURNING ${ACTION_COLUMNS}`,
      parameters: [...parameters, [...from]],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `economic action transition to ${to} lost the guarded race (status changed concurrently)`,
        details: { id },
      });
    }
    return toAction(row);
  }

  async insertAuthorization(input: InsertAuthorizationInput): Promise<PaymentAuthorizationRecord> {
    const result = await this.executor.execute<AuthorizationRow>({
      // ON CONFLICT DO NOTHING (untargeted: the id primary key, the
      // one-authorization-per-action key OR the one-per-reservation-
      // operation key) converges duplicate issuance into the typed
      // IDEMPOTENCY_KEY_REUSED failure below (ECO-003: double
      // reservation is unrepresentable).
      sql: `INSERT INTO economics.payment_authorizations (${AUTHORIZATION_COLUMNS})
VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, NULL, $9)
ON CONFLICT DO NOTHING
RETURNING ${AUTHORIZATION_COLUMNS}`,
      parameters: [
        input.id,
        input.economicActionId,
        input.applicationId,
        input.tenantId,
        JSON.stringify(input.constraints),
        input.status,
        input.reservationOperationId,
        JSON.stringify(input.admissionEvidence),
        input.issuedAt,
        input.expiresAt,
      ],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message:
          "an authorization already exists for this economic action (or the reservation operation already carries one)",
        details: { economicActionId: input.economicActionId },
      });
    }
    return toAuthorization(row);
  }

  async getAuthorizationById(
    applicationId: string,
    id: string,
  ): Promise<PaymentAuthorizationRecord | null> {
    const result = await this.executor.execute<AuthorizationRow>({
      sql: `SELECT ${AUTHORIZATION_COLUMNS} FROM economics.payment_authorizations WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, id],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAuthorization(row);
  }

  async getAuthorizationForAction(
    applicationId: string,
    economicActionId: string,
  ): Promise<PaymentAuthorizationRecord | null> {
    const result = await this.executor.execute<AuthorizationRow>({
      sql: `SELECT ${AUTHORIZATION_COLUMNS} FROM economics.payment_authorizations WHERE application_id = $1 AND economic_action_id = $2`,
      parameters: [applicationId, economicActionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAuthorization(row);
  }

  async transitionAuthorization(
    applicationId: string,
    id: string,
    from: readonly string[],
    to: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<PaymentAuthorizationRecord> {
    const locked = await this.executor.execute<{ status: string }>({
      sql: `SELECT status FROM economics.payment_authorizations WHERE application_id = $1 AND id = $2 FOR UPDATE`,
      parameters: [applicationId, id],
    });
    const current = first(locked.rows);
    if (current === undefined) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "authorization not found in this application",
        details: { id },
      });
    }
    if (!from.includes(current.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `authorization is ${current.status}; expected one of ${from.join(", ")}`,
        details: { id, status: current.status },
      });
    }
    const parameters: unknown[] = [applicationId, id, to, patch.consumedAt ?? null];
    const result = await this.executor.execute<AuthorizationRow>({
      sql: `UPDATE economics.payment_authorizations
SET status = $3, consumed_at = $4
WHERE application_id = $1 AND id = $2 AND status = ANY($5)
RETURNING ${AUTHORIZATION_COLUMNS}`,
      parameters: [...parameters, [...from]],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `authorization transition to ${to} lost the guarded race`,
        details: { id },
      });
    }
    return toAuthorization(row);
  }

  async insertSettlement(input: InsertSettlementInput): Promise<SettlementObservationRecord> {
    const result = await this.executor.execute<SettlementRow>({
      sql: `INSERT INTO economics.settlement_observations (${SETTLEMENT_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (application_id, rail_id, rail_transaction_ref) DO NOTHING
RETURNING ${SETTLEMENT_COLUMNS}`,
      parameters: [
        input.id,
        input.economicActionId,
        input.authorizationId,
        input.applicationId,
        input.tenantId,
        input.railId,
        input.railTransactionRef,
        input.status,
        input.settledAmountMicroUsd,
        input.currency,
        input.observedAt,
        input.evidenceDigest,
        input.recordedAt,
      ],
    });
    const inserted = first(result.rows);
    if (inserted !== undefined) {
      return toSettlement(inserted);
    }
    // Converge: the same external rail transaction already has its
    // durable observation (duplicate settlement from retries dies here).
    const existing = await this.executor.execute<SettlementRow>({
      sql: `SELECT ${SETTLEMENT_COLUMNS} FROM economics.settlement_observations
WHERE application_id = $1 AND rail_id = $2 AND rail_transaction_ref = $3`,
      parameters: [input.applicationId, input.railId, input.railTransactionRef],
    });
    const row = first(existing.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "settlement convergence conflict disappeared during arbitration",
        details: { railId: input.railId, railTransactionRef: input.railTransactionRef },
      });
    }
    return toSettlement(row);
  }

  async getSettlementForAction(
    applicationId: string,
    economicActionId: string,
  ): Promise<SettlementObservationRecord | null> {
    const result = await this.executor.execute<SettlementRow>({
      sql: `SELECT ${SETTLEMENT_COLUMNS} FROM economics.settlement_observations
WHERE application_id = $1 AND economic_action_id = $2
ORDER BY (authorization_id IS NULL), recorded_at DESC, id DESC
LIMIT 1`,
      parameters: [applicationId, economicActionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSettlement(row);
  }

  async findSettlementByRef(
    applicationId: string,
    railId: string,
    railTransactionRef: string,
  ): Promise<SettlementObservationRecord | null> {
    const result = await this.executor.execute<SettlementRow>({
      sql: `SELECT ${SETTLEMENT_COLUMNS} FROM economics.settlement_observations
WHERE application_id = $1 AND rail_id = $2 AND rail_transaction_ref = $3`,
      parameters: [applicationId, railId, railTransactionRef],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSettlement(row);
  }

  async insertDelivery(input: InsertDeliveryInput): Promise<DeliveryObservationRecord> {
    const result = await this.executor.execute<DeliveryRow>({
      sql: `INSERT INTO economics.delivery_observations (${DELIVERY_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING ${DELIVERY_COLUMNS}`,
      parameters: [
        input.id,
        input.economicActionId,
        input.applicationId,
        input.tenantId,
        input.kind,
        input.digest,
        input.contentRef,
        input.observedAt,
        input.recordedAt,
      ],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "delivery insert returned no row",
      });
    }
    return toDelivery(row);
  }

  async listDeliveries(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly DeliveryObservationRecord[]> {
    const result = await this.executor.execute<DeliveryRow>({
      sql: `SELECT ${DELIVERY_COLUMNS} FROM economics.delivery_observations
WHERE application_id = $1 AND economic_action_id = $2 ORDER BY recorded_at, id`,
      parameters: [applicationId, economicActionId],
    });
    return result.rows.map(toDelivery);
  }

  async appendEvent(input: InsertEventInput): Promise<EconomicActionEvent> {
    const result = await this.executor.execute<EventRow>({
      sql: `INSERT INTO economics.economic_action_events (${EVENT_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
RETURNING ${EVENT_COLUMNS}`,
      parameters: [
        input.eventId,
        input.economicActionId,
        input.applicationId,
        input.tenantId,
        input.sequence,
        input.type,
        input.cause,
        JSON.stringify(input.reference),
        JSON.stringify(input.payload),
        input.occurredAt,
      ],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message:
          "economic action event insert rejected (gapless sequence or vocabulary constraint)",
        details: { economicActionId: input.economicActionId, sequence: input.sequence },
      });
    }
    return toEvent(row);
  }

  async listEvents(
    applicationId: string,
    economicActionId: string,
  ): Promise<readonly EconomicActionEvent[]> {
    const result = await this.executor.execute<EventRow>({
      sql: `SELECT ${EVENT_COLUMNS} FROM economics.economic_action_events
WHERE application_id = $1 AND economic_action_id = $2 ORDER BY sequence`,
      parameters: [applicationId, economicActionId],
    });
    return result.rows.map(toEvent);
  }

  async listActionsOfApplication(applicationId: string): Promise<readonly EconomicActionRecord[]> {
    const result = await this.executor.execute<ActionRow>({
      sql: `SELECT ${ACTION_COLUMNS} FROM economics.economic_actions WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toAction);
  }

  async listAuthorizationsOfApplication(
    applicationId: string,
  ): Promise<readonly PaymentAuthorizationRecord[]> {
    const result = await this.executor.execute<AuthorizationRow>({
      sql: `SELECT ${AUTHORIZATION_COLUMNS} FROM economics.payment_authorizations WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toAuthorization);
  }

  async listSettlementsOfApplication(
    applicationId: string,
  ): Promise<readonly SettlementObservationRecord[]> {
    const result = await this.executor.execute<SettlementRow>({
      sql: `SELECT ${SETTLEMENT_COLUMNS} FROM economics.settlement_observations WHERE application_id = $1 ORDER BY recorded_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toSettlement);
  }

  async listDeliveriesOfApplication(
    applicationId: string,
  ): Promise<readonly DeliveryObservationRecord[]> {
    const result = await this.executor.execute<DeliveryRow>({
      sql: `SELECT ${DELIVERY_COLUMNS} FROM economics.delivery_observations WHERE application_id = $1 ORDER BY recorded_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toDelivery);
  }
}

interface IdempotencyLedgerRow {
  readonly id: string;
  readonly durable_outcome: unknown;
}

export class SqlEconomicsIdempotency implements EconomicsIdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly storeFactory: (tx: Transaction) => EconomicStore,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: EconomicsIdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (tx: EconomicsTx) => Promise<T>,
  ): Promise<EconomicsIdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      const txStore = this.storeFactory(tx);

      const inserted = await tx.execute<{ id: string }>({
        sql: `INSERT INTO platform.idempotency_records
  (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
VALUES ($1, $2, $3, $4, $5, $6, '"pending"'::jsonb)
ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
DO NOTHING
RETURNING id`,
        parameters: [
          this.generateId(),
          scope.actorId,
          scope.applicationId,
          operationName,
          idempotencyKey,
          requestFingerprint,
        ],
      });

      if (inserted.rows.length === 0) {
        const existing = await tx.execute<IdempotencyLedgerRow & { request_fingerprint: string }>({
          sql: `SELECT durable_outcome, request_fingerprint FROM platform.idempotency_records
WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [scope.applicationId, operationName, idempotencyKey],
        });
        const row = first(existing.rows);
        if (row === undefined) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "idempotency key conflict disappeared during arbitration",
          });
        }
        if (row.request_fingerprint !== requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { operationName },
          });
        }
        return { outcome: row.durable_outcome as T, replayed: true };
      }

      const ledgerRow = first(inserted.rows);
      if (ledgerRow === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ledger insert returned no row",
        });
      }
      const outcome = await work({ store: txStore });
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerRow.id],
      });
      return { outcome, replayed: false };
    });
  }
}

/** Composition wiring: SQL store + arbitration over one DatabasePort. */
export function createSqlEconomicsModule(db: DatabasePort, generateId: () => string) {
  const store = new SqlEconomicStore(db);
  const idempotency = new SqlEconomicsIdempotency(db, (tx) => new SqlEconomicStore(tx), generateId);
  return { store, idempotency };
}
