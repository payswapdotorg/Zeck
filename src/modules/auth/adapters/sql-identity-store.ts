/**
 * SQL adapter for the auth module (WORK-002).
 *
 * Bridges the module's `IdentityStore` and `IdempotencyPort` to the
 * provider-neutral platform `DatabasePort` (`IMPLEMENTATION.md` §3: module
 * adapters bridge to the platform). No driver/SDK import happens here — the
 * platform port is the only database surface (`pg` is owned by
 * `src/platform/db/` per the SDK boundary table).
 *
 * Cross-schema note: `findMembershipWithApplicationTenant` joins
 * `identity.memberships` with `applications.applications`. The coupling is
 * the durable composite foreign key `(application_id, tenant_id)` defined by
 * migration 0001; the join is confined to this adapter (infrastructure), no
 * TypeScript-level cross-module import exists.
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { Actor, ProvisionActorInput } from "../domain/actor";
import type { ApplicationRole } from "../domain/roles";
import type { MembershipRecord } from "../domain/scope";
import type {
  IdempotencyArbitration,
  IdempotencyPort,
  IdempotencyScope,
} from "../ports/idempotency";
import type {
  IdentityStore,
  InsertMembershipInput,
  ListMembershipsFilter,
  MembershipScopeRow,
} from "../ports/identity-store";

type Executor = Pick<DatabasePort, "execute">;

/** First row or undefined (noUncheckedIndexedAccess-safe). */
function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

interface MembershipRow {
  readonly id: string;
  readonly actor_id: string;
  readonly application_id: string | null;
  readonly tenant_id: string;
  readonly role: ApplicationRole;
  readonly created_at: Date | string;
}

interface ActorRow {
  readonly id: string;
  readonly external_subject: string | null;
  readonly display_name: string;
  readonly created_at: Date | string;
}

interface LedgerRow {
  readonly durable_outcome: unknown;
}

function toMembership(row: MembershipRow): MembershipRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    role: row.role,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toActor(row: ActorRow): Actor {
  return {
    id: row.id,
    externalSubject: row.external_subject,
    displayName: row.display_name,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

class SqlIdentityStore implements IdentityStore {
  constructor(private readonly exec: Executor) {}

  async provisionActor(input: ProvisionActorInput & { id: string }): Promise<Actor> {
    const inserted = await this.exec.execute<ActorRow>({
      sql: `INSERT INTO identity.actors (id, external_subject, display_name)
VALUES ($1, $2, $3)
ON CONFLICT (external_subject) DO UPDATE SET external_subject = EXCLUDED.external_subject
RETURNING id, external_subject, display_name, created_at`,
      parameters: [input.id, input.externalSubject ?? null, input.displayName],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return toActor(row);
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "actor provisioning returned no row",
    });
  }

  async findActor(id: string): Promise<Actor | null> {
    const found = await this.exec.execute<ActorRow>({
      sql: "SELECT id, external_subject, display_name, created_at FROM identity.actors WHERE id = $1",
      parameters: [id],
    });
    const row = first(found.rows);
    return row === undefined ? null : toActor(row);
  }

  async findMembershipWithApplicationTenant(
    actorId: string,
    applicationId: string,
  ): Promise<MembershipScopeRow | null> {
    const found = await this.exec.execute<MembershipRow & { application_tenant_id: string | null }>(
      {
        sql: `SELECT m.id, m.actor_id, m.application_id, m.tenant_id, m.role, m.created_at,
              a.tenant_id AS application_tenant_id
            FROM identity.memberships m
            LEFT JOIN applications.applications a ON a.id = m.application_id
            WHERE m.actor_id = $1 AND m.application_id = $2`,
        parameters: [actorId, applicationId],
      },
    );
    const row = first(found.rows);
    if (row === undefined) {
      return null;
    }
    return {
      membership: toMembership(row),
      applicationTenantId: row.application_tenant_id,
    };
  }

  async findTenantMembership(actorId: string, tenantId: string): Promise<MembershipRecord | null> {
    const found = await this.exec.execute<MembershipRow>({
      sql: `SELECT id, actor_id, application_id, tenant_id, role, created_at
            FROM identity.memberships
            WHERE actor_id = $1 AND tenant_id = $2 AND application_id IS NULL`,
      parameters: [actorId, tenantId],
    });
    const row = first(found.rows);
    return row === undefined ? null : toMembership(row);
  }

  async listMemberships(filter: ListMembershipsFilter): Promise<readonly MembershipRecord[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filter.applicationId !== undefined) {
      parameters.push(filter.applicationId);
      clauses.push(`application_id = $${parameters.length}`);
    }
    if (filter.tenantId !== undefined) {
      parameters.push(filter.tenantId);
      clauses.push(`tenant_id = $${parameters.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const found = await this.exec.execute<MembershipRow>({
      sql: `SELECT id, actor_id, application_id, tenant_id, role, created_at
            FROM identity.memberships ${where}`,
      parameters,
    });
    return found.rows.map(toMembership);
  }

  async insertMembership(
    input: InsertMembershipInput & { id: string },
  ): Promise<MembershipRecord | null> {
    const inserted = await this.exec.execute<MembershipRow>({
      sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (actor_id, application_id) DO NOTHING
RETURNING id, actor_id, application_id, tenant_id, role, created_at`,
      parameters: [input.id, input.actorId, input.applicationId, input.tenantId, input.role],
    });
    const row = first(inserted.rows);
    return row === undefined ? null : toMembership(row);
  }

  async updateMembershipRole(
    membershipId: string,
    role: ApplicationRole,
  ): Promise<MembershipRecord | null> {
    const updated = await this.exec.execute<MembershipRow>({
      sql: `UPDATE identity.memberships SET role = $2 WHERE id = $1
            RETURNING id, actor_id, application_id, tenant_id, role, created_at`,
      parameters: [membershipId, role],
    });
    const row = first(updated.rows);
    return row === undefined ? null : toMembership(row);
  }

  async deleteMembership(membershipId: string): Promise<boolean> {
    const deleted = await this.exec.execute({
      sql: "DELETE FROM identity.memberships WHERE id = $1",
      parameters: [membershipId],
    });
    return deleted.rowCount > 0;
  }

  async countApplicationOwners(applicationId: string): Promise<number> {
    const counted = await this.exec.execute<{ owner_count: number }>({
      sql: `SELECT count(*)::int AS owner_count
            FROM identity.memberships
            WHERE application_id = $1 AND role = 'owner'`,
      parameters: [applicationId],
    });
    return counted.rows[0]?.owner_count ?? 0;
  }
}

export class SqlIdempotency implements IdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (txStore: IdentityStore) => Promise<T>,
  ): Promise<IdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      // Ledger insert and guarded work share this transaction: the recorded
      // row exists iff the operation's durable outcome exists.
      const insertSql =
        scope.applicationId === null
          ? `INSERT INTO platform.idempotency_records
               (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
             VALUES ($1, $2, NULL, $3, $4, $5, '"pending"'::jsonb)
             ON CONFLICT (actor_id, operation_name, idempotency_key) WHERE application_id IS NULL
             DO NOTHING
             RETURNING id`
          : `INSERT INTO platform.idempotency_records
               (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
             VALUES ($1, $2, $3, $4, $5, $6, '"pending"'::jsonb)
             ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
             DO NOTHING
             RETURNING id`;

      const inserted =
        scope.applicationId === null
          ? await tx.execute<{ id: string }>({
              sql: insertSql,
              parameters: [
                this.generateId(),
                scope.actorId,
                operationName,
                idempotencyKey,
                requestFingerprint,
              ],
            })
          : await tx.execute<{ id: string }>({
              sql: insertSql,
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
        // A previous request (committed, or committing concurrently — the
        // unique index arbitration makes this call wait for the winner)
        // already owns the key. Same fingerprint replays the durable
        // outcome; different fingerprint is key reuse.
        const existing =
          scope.applicationId === null
            ? await tx.execute<LedgerRow>({
                sql: `SELECT durable_outcome FROM platform.idempotency_records
                      WHERE actor_id = $1 AND application_id IS NULL AND operation_name = $2 AND idempotency_key = $3`,
                parameters: [scope.actorId, operationName, idempotencyKey],
              })
            : await tx.execute<LedgerRow>({
                sql: `SELECT durable_outcome FROM platform.idempotency_records
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
        const recordedFingerprint = await this.recordedFingerprint(
          tx,
          scope,
          operationName,
          idempotencyKey,
        );
        if (recordedFingerprint !== requestFingerprint) {
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
      const ledgerId = ledgerRow.id;
      const outcome = await work(new SqlIdentityStore(tx));
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerId],
      });
      return { outcome, replayed: false };
    });
  }

  private async recordedFingerprint(
    tx: Transaction,
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
  ): Promise<string> {
    const rows =
      scope.applicationId === null
        ? await tx.execute<{ request_fingerprint: string }>({
            sql: `SELECT request_fingerprint FROM platform.idempotency_records
                  WHERE actor_id = $1 AND application_id IS NULL AND operation_name = $2 AND idempotency_key = $3`,
            parameters: [scope.actorId, operationName, idempotencyKey],
          })
        : await tx.execute<{ request_fingerprint: string }>({
            sql: `SELECT request_fingerprint FROM platform.idempotency_records
                  WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
            parameters: [scope.applicationId, operationName, idempotencyKey],
          });
    return first(rows.rows)?.request_fingerprint ?? "";
  }
}

export interface SqlAuthModule {
  readonly store: IdentityStore;
  readonly idempotency: IdempotencyPort;
}

/** Compose the SQL-backed auth module over a platform `DatabasePort`. */
export function createSqlAuthModule(db: DatabasePort, generateId: () => string): SqlAuthModule {
  return {
    store: new SqlIdentityStore(db),
    idempotency: new SqlIdempotency(db, generateId),
  };
}
